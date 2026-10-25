/**
 * Persistence for discovery results.
 *
 * The cache lives in the user's standard cache directory
 * (`%LOCALAPPDATA%\dsh-java-dev` on Windows, `~/Library/Caches/dsh-java-dev` on
 * macOS, `$XDG_CACHE_HOME/dsh-java-dev` on Linux) — never inside a DSH
 * installation and never inside the user's project.
 *
 * That is what makes discovery "once per machine" instead of "once per process":
 * the first run (typically right after installing the plugin) scans and stores
 * the paths, later sessions start from the stored result and only re-validate
 * that the paths still exist.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cacheDir, exists, isFile } from './platform.js';

/** Bump when the stored shape changes; older files are ignored. */
export const CACHE_VERSION = 2;

/** Tool keys with their "primary path" accessor, used for re-validation. */
const PRIMARY_ACCESSORS = {
  jdks: (e) => e.javaHome || e.path,
  gradles: (e) => e.gradleHome || e.path,
  androidSdks: (e) => e.path,
  ffmpegs: (e) => e.path,
  lwjgls: (e) => e.libDir,
  ideas: (e) => e.path
};

export function defaultCacheFile(overrideDir) {
  return join(cacheDir(overrideDir), 'discovery.json');
}

/**
 * Read a stored discovery result.
 * @param {string} file
 * @returns {object|null}
 */
export function loadDiscovery(file) {
  if (!file || !isFile(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || data.version !== CACHE_VERSION || !data.tools) return null;
    if (!data.scannedAt || !Number.isFinite(Date.parse(data.scannedAt))) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Drop cached entries whose files no longer exist (uninstalled / moved tool),
 * so a stale cache degrades gracefully instead of reporting ghosts.
 * @param {object} data stored discovery payload
 * @returns {object} validated payload
 */
export function validateDiscovery(data) {
  const tools = {};
  let dropped = 0;
  for (const [key, accessor] of Object.entries(PRIMARY_ACCESSORS)) {
    const list = Array.isArray(data.tools[key]) ? data.tools[key] : [];
    const kept = [];
    for (const entry of list) {
      const primary = accessor(entry);
      if (primary && exists(primary)) kept.push(entry);
      else dropped += 1;
    }
    tools[key] = kept;
  }
  const graphics = (data.tools.graphics || []).filter((g) => g && g.path && exists(g.path));
  tools.graphics = graphics;
  return { ...data, tools, dropped };
}

/**
 * Persist a discovery result (best effort: a read-only cache dir must not break tools).
 * @param {string} file
 * @param {object} data
 * @returns {boolean}
 */
export function saveDiscovery(file, data) {
  if (!file) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function clearDiscovery(file) {
  if (!file) return false;
  try { rmSync(file, { force: true }); return true; } catch { return false; }
}

/** Whole-millisecond age of a stored result. */
export function ageMs(data) {
  const ts = Date.parse(data?.scannedAt || '');
  return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}
