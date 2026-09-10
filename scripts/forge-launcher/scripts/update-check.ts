import spawn from "cross-spawn";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import semver from "semver";
import { warn } from "./format.ts";

const PKG_NAME = "forge-launcher";
const CACHE_TTL_HOURS = Number(process.env.FORGE_UPDATE_CHECK_INTERVAL_HOURS) || 24;
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;

const nodeRequire = createRequire(import.meta.url);

export interface UpdateInfo {
  current: string;
  latest: string;
  tag: string;
}

export interface UpdateCache {
  checkedAt: string;
  latest: string;
  url?: string;
}

export interface CheckOptions {
  skip?: boolean;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  cacheFile?: string;
  registryReader?: () => string | null;
}

/** The installed forge-launcher version (read from package.json at runtime). */
export function currentVersion(): string {
  return (nodeRequire("../package.json") as { version: string }).version;
}

/**
 * Which npm dist-tag to check. A prerelease install (contains `-`, e.g.
 * `1.0.0-beta.2`) checks the `beta` tag; a release install checks `latest`.
 * Override with FORGE_UPDATE_CHECK_TAG.
 */
export function distTagFor(version: string): string {
  const override = process.env.FORGE_UPDATE_CHECK_TAG;
  if (override) return override;
  return semver.prerelease(version) ? "beta" : "latest";
}

/** Let npm resolve environment overrides, npmrc precedence and interpolation. */
export function configuredRegistry(): string | null {
  const result = spawn.sync("npm", ["config", "get", "registry", "--update-notifier=false"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    warn("Skipping update check: 'npm config get registry' failed or timed out.");
    return null;
  }
  return result.stdout.trim();
}

/** npm registry endpoint for a package's dist-tag, without a fallback registry. */
export function registryUrl(tag: string, registry: string): string | null {
  try {
    const url = new URL(registry);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username || url.password || url.search || url.hash
    ) {
      throw new TypeError("Unsupported npm registry URL");
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${PKG_NAME}/${encodeURIComponent(tag)}`;
    return url.href;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    warn("Skipping update check: npm's registry must be an HTTP(S) URL without credentials, a query or a fragment.");
    return null;
  }
}

/** True when `latest` is a newer semver than `current` (unparseable → false). */
export function isNewer(current: string, latest: string): boolean {
  const cur = semver.valid(current);
  const lat = semver.valid(latest);
  if (!cur || !lat) return false;
  return semver.gt(lat, cur);
}

/** Skips the check when disabled via env or in CI. */
export function shouldCheck(): boolean {
  const skip = process.env.FORGE_SKIP_UPDATE_CHECK;
  if (skip === "1" || skip === "true") return false;
  if (process.env.CI) return false;
  return true;
}

/** User-level cache file so the registry is only hit once per TTL window. */
export function cachePath(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
      : path.join(os.homedir(), ".cache");
  return path.join(base, "forge-launcher", "update-check.json");
}

export function readCache(file = cachePath()): UpdateCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

export function writeCache(latest: string, url: string, file = cachePath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ checkedAt: new Date().toISOString(), latest, url }, null, 2),
      "utf8",
    );
  } catch {
    // never fail the launcher over a cache write
  }
}

/** A cached result is fresh when it was written within the TTL window. */
export function cacheFresh(cache: UpdateCache | null, now = Date.now()): boolean {
  if (!cache?.checkedAt || !cache.latest) return false;
  const checked = Date.parse(cache.checkedAt);
  if (Number.isNaN(checked)) return false;
  return now - checked < CACHE_TTL_MS;
}

async function fetchLatest(url: string, opts: CheckOptions): Promise<string | null> {
  const fetcher = opts.fetcher ?? fetch;
  try {
    const res = await fetcher(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * Checks the registry for a newer forge-launcher. Returns update info when one
 * exists, null otherwise (or when the check is disabled/offline). Honors a
 * daily cache for the selected registry and tag so repeated invocations are
 * network-free.
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateInfo | null> {
  if (opts.skip || !shouldCheck()) return null;
  const current = currentVersion();
  const tag = distTagFor(current);
  const file = opts.cacheFile ?? cachePath();
  const registry = (opts.registryReader ?? configuredRegistry)();
  if (registry === null) return null;
  const url = registryUrl(tag, registry);
  if (!url) return null;

  const cached = readCache(file);
  if (cached?.url === url && cacheFresh(cached)) {
    return isNewer(current, cached.latest)
      ? { current, latest: cached.latest, tag }
      : null;
  }

  const latest = await fetchLatest(url, opts);
  if (!latest) return null;
  writeCache(latest, url, file);
  return isNewer(current, latest) ? { current, latest, tag } : null;
}

/** Prints a single-line upgrade notice (best effort). */
export function printUpdateNotice(info: UpdateInfo): void {
  warn(`A new forge-launcher is available: ${info.current} → ${info.latest}`);
  warn(`  Upgrade with: npm install -g forge-launcher@${info.tag}`);
}
