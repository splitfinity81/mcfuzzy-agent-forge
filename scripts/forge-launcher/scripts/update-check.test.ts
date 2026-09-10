import { after, test } from "node:test";
import assert from "node:assert/strict";
import spawn from "cross-spawn";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cacheFresh,
  checkForUpdate,
  configuredRegistry,
  currentVersion,
  distTagFor,
  isNewer,
  readCache,
  registryUrl,
  shouldCheck,
  type UpdateCache,
} from "./update-check.ts";

const TEST_REGISTRY = "https://test-feed.invalid/npm/";
const TEST_URL = "https://test-feed.invalid/npm/forge-launcher/beta";
const testOptions = { registryReader: () => TEST_REGISTRY };
const updateEnv = {
  FORGE_SKIP_UPDATE_CHECK: undefined,
  FORGE_UPDATE_CHECK_TAG: undefined,
  CI: undefined,
};
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fl-updcheck-"));
  tempDirs.push(dir);
  return dir;
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withNpmConfig(fn: (root: string) => Promise<void>): Promise<void> {
  const root = tmpDir();
  const cwd = process.cwd();
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"registry-fixture","version":"1.0.0"}');
  fs.writeFileSync(path.join(root, "user.npmrc"), "");
  fs.writeFileSync(path.join(root, "global.npmrc"), "");
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.toLowerCase().startsWith("npm_config_"))
      .map((key) => [key, undefined]),
  );
  env.npm_config_userconfig = path.join(root, "user.npmrc");
  env.npm_config_globalconfig = path.join(root, "global.npmrc");
  env.FORGE_SKIP_UPDATE_CHECK = undefined;
  env.FORGE_UPDATE_CHECK_TAG = undefined;
  env.CI = undefined;
  await withEnv(env, async () => {
    process.chdir(root);
    try {
      await fn(root);
    } finally {
      process.chdir(cwd);
    }
  });
}

function tmpCacheFile(): string {
  return path.join(tmpDir(), "update-check.json");
}

function mockFetcher(version: string | null, error = false): typeof fetch {
  return async () => {
    if (error) throw new Error("offline");
    return new Response(JSON.stringify(version === null ? {} : { version }), {
      status: version === null ? 404 : 200,
    });
  };
}

function countingFetcher(counter: { calls: number }): typeof fetch {
  return async () => {
    counter.calls += 1;
    throw new Error("should not fetch");
  };
}

test("distTagFor picks beta for prereleases and latest for releases", async () => {
  await withEnv({ FORGE_UPDATE_CHECK_TAG: undefined }, () => {
    assert.equal(distTagFor("1.0.0-beta.2"), "beta");
    assert.equal(distTagFor("1.0.0"), "latest");
  });
});

test("distTagFor honors FORGE_UPDATE_CHECK_TAG", async () => {
  await withEnv({ FORGE_UPDATE_CHECK_TAG: "next" }, () => {
    assert.equal(distTagFor("1.0.0"), "next");
  });
});

test("isNewer orders semver including prereleases", () => {
  assert.equal(isNewer("1.0.0-beta.2", "1.0.0-beta.3"), true);
  assert.equal(isNewer("1.0.0-beta.2", "1.0.0"), true);
  assert.equal(isNewer("1.0.0", "1.0.0-beta.2"), false);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "0.9.9"), false);
  assert.equal(isNewer("garbage", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "garbage"), false);
});

test("registryUrl preserves feed paths and strips trailing slashes", () => {
  assert.equal(registryUrl("beta", "https://registry.npmjs.org/"), "https://registry.npmjs.org/forge-launcher/beta");
  assert.equal(registryUrl("beta", "http://localhost:4873/"), "http://localhost:4873/forge-launcher/beta");
  assert.equal(registryUrl("beta", "https://test-feed.invalid/npm///"), TEST_URL);
  assert.equal(registryUrl("beta", "  https://test-feed.invalid/npm/  "), TEST_URL);
  assert.equal(registryUrl("preview/test", TEST_REGISTRY), "https://test-feed.invalid/npm/forge-launcher/preview%2Ftest");
});

for (const scenario of [
  { name: "npm's default", expected: "https://registry.npmjs.org/" },
  { name: "the global npmrc", global: "registry=https://global-feed.invalid/npm/\n", expected: "https://global-feed.invalid/npm/" },
  { name: "the user npmrc over global", user: "registry=https://user-feed.invalid/npm/\n", global: "registry=https://global-feed.invalid/npm/\n", expected: "https://user-feed.invalid/npm/" },
  { name: "the project npmrc over user", project: "registry=https://project-feed.invalid/npm/\n", user: "registry=https://user-feed.invalid/npm/\n", expected: "https://project-feed.invalid/npm/" },
  { name: "a lowercase environment override", project: "registry=https://project-feed.invalid/npm/\n", env: { npm_config_registry: "https://env-feed.invalid/npm/" }, expected: "https://env-feed.invalid/npm/" },
  { name: "an uppercase environment override", user: "registry=https://user-feed.invalid/npm/\n", env: { NPM_CONFIG_REGISTRY: "https://env-feed.invalid/npm/" }, expected: "https://env-feed.invalid/npm/" },
  { name: "npmrc variable interpolation", user: `registry=\${FORGE_TEST_REGISTRY}\n`, env: { FORGE_TEST_REGISTRY: "https://interpolated-feed.invalid/npm/" }, expected: "https://interpolated-feed.invalid/npm/" },
]) {
  test(`configuredRegistry honors ${scenario.name}`, async () => {
    await withNpmConfig(async (root) => {
      if (scenario.global) fs.writeFileSync(path.join(root, "global.npmrc"), scenario.global);
      if (scenario.user) fs.writeFileSync(path.join(root, "user.npmrc"), scenario.user);
      if (scenario.project) fs.writeFileSync(path.join(root, ".npmrc"), scenario.project);
      await withEnv(scenario.env ?? {}, () => {
        assert.equal(configuredRegistry(), scenario.expected);
      });
    });
  });
}

test("registry lookup is bounded and queries only the registry", (t) => {
  const command = t.mock.method(spawn, "sync", () => ({
    pid: 0, status: 0, signal: null, output: [], stdout: `${TEST_REGISTRY}\r\n`, stderr: "",
  }));
  assert.equal(configuredRegistry(), TEST_REGISTRY);
  assert.equal(command.mock.callCount(), 1);
  assert.deepEqual(command.mock.calls[0].arguments, [
    "npm", ["config", "get", "registry", "--update-notifier=false"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  ]);
});

for (const failure of [
  { name: "a nonzero exit", status: 1 },
  { name: "a missing npm command", status: null, error: Object.assign(new Error("not installed"), { code: "ENOENT" }) },
  { name: "a timeout with partial output", status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
]) {
  test(`registry lookup skips updates after ${failure.name}`, async (t) => {
    t.mock.method(spawn, "sync", () => ({
      pid: 0, status: failure.status, signal: null, output: [],
      stdout: TEST_REGISTRY, stderr: "sensitive npm diagnostic", error: failure.error,
    }));
    const output = t.mock.method(process.stdout, "write", () => true);
    await withEnv(updateEnv, async () => {
      const counter = { calls: 0 };
      const file = tmpCacheFile();
      fs.writeFileSync(file, JSON.stringify({
        checkedAt: new Date().toISOString(), latest: "9.9.9", url: TEST_URL,
      }));
      assert.equal(await checkForUpdate({ fetcher: countingFetcher(counter), cacheFile: file }), null);
      assert.equal(counter.calls, 0);
      const message = output.mock.calls.map((call) => String(call.arguments[0])).join("");
      assert.match(message, /Skipping update check/);
      assert.doesNotMatch(message, /sensitive npm diagnostic/);
    });
  });
}

test("unusable registry URLs skip updates without logging their contents", async (t) => {
  const output = t.mock.method(process.stdout, "write", () => true);
  await withEnv(updateEnv, async () => {
    for (const registry of [
      "", "undefined", "not-a-url", "file:///tmp/registry",
      "https://user:sensitive-value@test-feed.invalid/",
      "https://test-feed.invalid/?token=sensitive-value",
      "https://test-feed.invalid/#sensitive-value",
    ]) {
      const counter = { calls: 0 };
      assert.equal(await checkForUpdate({
        registryReader: () => registry,
        fetcher: countingFetcher(counter),
        cacheFile: tmpCacheFile(),
      }), null);
      assert.equal(counter.calls, 0);
    }
    const message = output.mock.calls.map((call) => String(call.arguments[0])).join("");
    assert.match(message, /Skipping update check/);
    assert.doesNotMatch(message, /sensitive-value/);
  });
});

test("a direct launch uses the registry in the user npmrc", async () => {
  await withNpmConfig(async (root) => {
    fs.writeFileSync(path.join(root, "user.npmrc"), "registry=https://user-feed.invalid/npm/\n");
    const urls: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ version: "9.9.9" }));
    };
    const info = await checkForUpdate({ fetcher, cacheFile: tmpCacheFile() });
    assert.equal(info?.latest, "9.9.9");
    assert.deepEqual(urls, ["https://user-feed.invalid/npm/forge-launcher/beta"]);
  });
});

test("cacheFresh is true within the TTL and false after", () => {
  const now = Date.now();
  const fresh: UpdateCache = { checkedAt: new Date(now - 60_000).toISOString(), latest: "1.0.0" };
  const stale: UpdateCache = {
    checkedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    latest: "1.0.0",
  };
  assert.equal(cacheFresh(fresh, now), true);
  assert.equal(cacheFresh(stale, now), false);
  assert.equal(cacheFresh(null, now), false);
  assert.equal(cacheFresh({ checkedAt: "not-a-date", latest: "1.0.0" }, now), false);
});

test("shouldCheck respects env and CI", async () => {
  await withEnv({ FORGE_SKIP_UPDATE_CHECK: undefined, CI: undefined }, () => {
    assert.equal(shouldCheck(), true);
  });
  await withEnv({ FORGE_SKIP_UPDATE_CHECK: "1", CI: undefined }, () => {
    assert.equal(shouldCheck(), false);
  });
  await withEnv({ FORGE_SKIP_UPDATE_CHECK: undefined, CI: "true" }, () => {
    assert.equal(shouldCheck(), false);
  });
});

test("checkForUpdate reports a newer version and caches it", async () => {
  await withEnv(updateEnv, async () => {
    const file = tmpCacheFile();
    const info = await checkForUpdate({ ...testOptions, fetcher: mockFetcher("9.9.9"), cacheFile: file });
    assert.ok(info);
    assert.equal(info.latest, "9.9.9");
    assert.equal(info.current, currentVersion());
    assert.equal(info.tag, "beta");
    assert.equal(readCache(file)?.latest, "9.9.9");
    assert.equal(readCache(file)?.url, TEST_URL);
  });
});

test("checkForUpdate returns null on 404 and offline, and caches up-to-date results", async () => {
  await withEnv(updateEnv, async () => {
    assert.equal(await checkForUpdate({ ...testOptions, fetcher: mockFetcher(null), cacheFile: tmpCacheFile() }), null);
    assert.equal(await checkForUpdate({ ...testOptions, fetcher: mockFetcher(null, true), cacheFile: tmpCacheFile() }), null);

    const file = tmpCacheFile();
    const info = await checkForUpdate({ ...testOptions, fetcher: mockFetcher(currentVersion()), cacheFile: file });
    assert.equal(info, null);
    assert.equal(readCache(file)?.latest, currentVersion());
  });
});

for (const scenario of [
  { name: "the CLI skip option", skip: true, env: {} },
  { name: "FORGE_SKIP_UPDATE_CHECK=1", env: { FORGE_SKIP_UPDATE_CHECK: "1" } },
  { name: "FORGE_SKIP_UPDATE_CHECK=true", env: { FORGE_SKIP_UPDATE_CHECK: "true" } },
  { name: "CI", env: { CI: "true" } },
]) {
  test(`checkForUpdate skips registry resolution and fetching for ${scenario.name}`, async () => {
    await withEnv({ ...updateEnv, ...scenario.env }, async () => {
      const counter = { calls: 0 };
      const info = await checkForUpdate({
        skip: scenario.skip,
        registryReader: () => { assert.fail("should not query npm"); },
        fetcher: countingFetcher(counter),
        cacheFile: tmpCacheFile(),
      });
      assert.equal(info, null);
      assert.equal(counter.calls, 0);
    });
  });
}

test("checkForUpdate honors a fresh cache without hitting the network", async () => {
  await withEnv(updateEnv, async () => {
    const file = tmpCacheFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ checkedAt: new Date().toISOString(), latest: "9.9.9", url: TEST_URL }),
    );
    const counter = { calls: 0 };
    const info = await checkForUpdate({ ...testOptions, fetcher: countingFetcher(counter), cacheFile: file });
    assert.ok(info);
    assert.equal(info.latest, "9.9.9");
    assert.equal(counter.calls, 0);
  });
});

test("checkForUpdate returns null from a fresh cache when up to date", async () => {
  await withEnv(updateEnv, async () => {
    const file = tmpCacheFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ checkedAt: new Date().toISOString(), latest: currentVersion(), url: TEST_URL }),
    );
    const counter = { calls: 0 };
    const info = await checkForUpdate({ ...testOptions, fetcher: countingFetcher(counter), cacheFile: file });
    assert.equal(info, null);
    assert.equal(counter.calls, 0);
  });
});

for (const source of [
  { name: "a legacy cache without an endpoint" },
  { name: "a different feed", url: "https://another-feed.invalid/forge-launcher/beta" },
  { name: "a different tag", url: "https://test-feed.invalid/npm/forge-launcher/latest" },
]) {
  test(`checkForUpdate does not reuse ${source.name}`, async () => {
    await withEnv(updateEnv, async () => {
      const file = tmpCacheFile();
      fs.writeFileSync(file, JSON.stringify({
        checkedAt: new Date().toISOString(), latest: "9.9.9", url: source.url,
      }));
      const urls: string[] = [];
      const fetcher: typeof fetch = async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ version: "8.8.8" }));
      };
      const info = await checkForUpdate({ ...testOptions, fetcher, cacheFile: file });
      assert.equal(info?.latest, "8.8.8");
      assert.deepEqual(urls, [TEST_URL]);
      assert.equal(readCache(file)?.url, TEST_URL);
    });
  });
}

test("feed failures never retry public npm or reuse a different feed's cache", async () => {
  await withEnv(updateEnv, async () => {
    for (const status of [401, 403, 404, 500, "offline"]) {
      const file = tmpCacheFile();
      const cached = {
        checkedAt: new Date().toISOString(), latest: "9.9.9",
        url: "https://registry.npmjs.org/forge-launcher/beta",
      };
      fs.writeFileSync(file, JSON.stringify(cached));
      const urls: string[] = [];
      const fetcher: typeof fetch = async (url) => {
        urls.push(String(url));
        if (typeof status === "string") throw new Error("offline");
        return new Response(null, { status });
      };
      const info = await checkForUpdate({ ...testOptions, fetcher, cacheFile: file });
      assert.equal(info, null);
      assert.deepEqual(urls, [TEST_URL]);
      assert.deepEqual(readCache(file), cached);
    }
  });
});
