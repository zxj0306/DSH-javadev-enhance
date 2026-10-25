/**
 * Tool discovery entry point.
 *
 * Behaviour
 *  - `scanTools()` looks for JDK / Gradle / Android SDK / FFmpeg / LWJGL /
 *    IntelliJ IDEA using, in order of trust: explicit config roots, environment
 *    variables, PATH, then a bounded filesystem walk of standard install
 *    locations (and drive roots on Windows).
 *  - results are persisted to a per-user cache file *outside* any DSH install,
 *    so a scan costs once per machine (default TTL: 6 h) instead of once per
 *    process.
 *  - `ensureDiscovery()` is the fire-and-forget variant the plugin calls on
 *    startup, i.e. "search automatically when the plugin is installed".
 *
 * Nothing in here is machine specific: no hard-coded vendor directories, no
 * hard-coded drives, no assumptions about Windows.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';
import { standardRoots, fixedDrives, envToolRoots, cacheDir, isDir } from './platform.js';
import { walkDirs } from './walk.js';
import {
  probeJdk, probeGradle, probeAndroidSdk, probeFfmpeg, probeLwjgl, probeIdea,
  probeEnvironment, dedupeBy
} from './probe.js';
import {
  defaultCacheFile, loadDiscovery, saveDiscovery, validateDiscovery, clearDiscovery, ageMs, CACHE_VERSION
} from './store.js';
import { readProjectHints, selectTools, majorOf, compareVersions, unescapeProperty } from './resolve.js';

/** Plugin configuration defaults (see also cordis.patch.yml). */
export const DEFAULT_CONFIG = {
  /** Extra roots to walk, in addition to the automatic ones. */
  toolRoots: [],
  /** Search the filesystem automatically on startup. */
  autoDiscover: true,
  /** Skip drive-root scanning (faster, but only standard dirs + PATH are used). */
  scanDrives: true,
  /** Deeper walk with a bigger budget (slower). */
  deepScan: false,
  /** How long a stored result stays valid, in ms (default 6 h). */
  cacheTtlMs: 6 * 60 * 60 * 1000,
  /** Override the cache *file* (defaults to `<user cache dir>/dsh-java-dev/discovery.json`). */
  cacheFile: null,
  /** Override the cache *directory*. */
  cacheDir: null,
  /** Directory budget for the walk. */
  budget: null,
  /** Wall-clock budget for the walk, in ms. */
  timeBudgetMs: null
};

const memory = new Map();
const inFlight = new Map();

/** Accept `scanTools([roots], refresh)`, `scanTools({...})` or `scanTools()`. */
export function normalizeOptions(input, forceRefresh = false) {
  const base = { ...DEFAULT_CONFIG };
  if (Array.isArray(input)) {
    return { ...base, toolRoots: input.map(String), refresh: !!forceRefresh };
  }
  if (input && typeof input === 'object') {
    return {
      ...base,
      ...input,
      toolRoots: Array.isArray(input.toolRoots) ? input.toolRoots.map(String) : [],
      refresh: !!(input.refresh ?? forceRefresh)
    };
  }
  return { ...base, refresh: !!forceRefresh };
}

export function cacheFileFor(opts) {
  if (opts.cacheFile) return resolvePath(opts.cacheFile);
  return defaultCacheFile(opts.cacheDir);
}

/** Roots discovered automatically (standard dirs + drives + env-provided roots). */
export function automaticRoots(opts = {}) {
  const roots = [
    ...opts.toolRoots,
    ...envToolRoots(),
    ...standardRoots()
  ];
  if (opts.scanDrives !== false) roots.push(...fixedDrives());
  if (opts.deepScan) roots.push(...standardRoots(), ...fixedDrives());
  const unique = [];
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const abs = isAbsolute(root) ? root : resolvePath(root);
    if (seen.has(abs) || !isDir(abs)) continue;
    seen.add(abs);
    unique.push(abs);
  }
  return unique;
}

function probeDir(dir) {
  const found = [];
  const jdk = probeJdk(dir);
  if (jdk) found.push(['jdks', jdk]);
  const gradle = probeGradle(dir);
  if (gradle) found.push(['gradles', gradle]);
  const sdk = probeAndroidSdk(dir);
  if (sdk) found.push(['androidSdks', sdk]);
  const ffmpeg = probeFfmpeg(dir);
  if (ffmpeg) found.push(['ffmpegs', ffmpeg]);
  const lwjgl = probeLwjgl(dir);
  if (lwjgl) found.push(['lwjgls', lwjgl]);
  const idea = probeIdea(dir);
  if (idea) found.push(['ideas', idea]);
  return found;
}

/** Run one discovery pass over the filesystem (no cache reads). */
export function discoverSync(opts) {
  const started = Date.now();
  const roots = automaticRoots(opts);
  const fromEnv = probeEnvironment();
  const found = { jdks: [], gradles: [], androidSdks: [], ffmpegs: [], lwjgls: [], ideas: [] };

  const walk = walkDirs(roots, {
    maxDepth: opts.deepScan ? 5 : 3,
    budget: opts.budget || (opts.deepScan ? 6000 : 1200),
    timeBudgetMs: opts.timeBudgetMs || (opts.deepScan ? 12000 : 2500),
    onDir: (dir) => {
      for (const [key, entry] of probeDir(dir)) found[key].push(entry);
    }
  });

  const tools = {
    jdks: sortJdks(dedupeBy([...fromEnv.jdks, ...found.jdks], 'javaHome')),
    gradles: dedupeBy([...fromEnv.gradles, ...found.gradles], 'gradleHome').sort((a, b) => compareVersions(b.version, a.version)),
    androidSdks: dedupeBy([...fromEnv.androidSdks, ...found.androidSdks], 'path'),
    ffmpegs: dedupeBy([...fromEnv.ffmpegs, ...found.ffmpegs], 'path'),
    lwjgls: dedupeBy([...fromEnv.lwjgls, ...found.lwjgls], 'libDir'),
    ideas: dedupeBy([...fromEnv.ideas, ...found.ideas], 'path'),
    graphics: fromEnv.graphics || []
  };

  return {
    version: CACHE_VERSION,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    roots,
    walk: { visited: walk.visited, truncated: walk.truncated },
    tools
  };
}

function sortJdks(jdks) {
  return [...jdks].sort((a, b) => compareVersions(b.version, a.version));
}

/** Back-compat OpenGL view (`project` / `system` / `vulkan` keys). */
function openGLView(lwjgls = [], graphics = []) {
  const out = lwjgls.map((l) => ({
    project: l.displayName,
    libDir: l.libDir,
    lwjgl: l.lwjgl,
    natives: l.natives,
    version: l.version || null
  }));
  for (const g of graphics) {
    if (g.kind === 'opengl') out.push({ system: g.path });
    else if (g.kind === 'vulkan') out.push({ vulkan: g.path });
    else out.push({ [g.kind]: g.path });
  }
  return out;
}

function shape(stored, meta = {}) {
  const tools = stored.tools || stored;
  return {
    jdks: tools.jdks || [],
    gradles: tools.gradles || [],
    androidSdks: tools.androidSdks || [],
    ffmpegs: tools.ffmpegs || [],
    lwjgls: tools.lwjgls || [],
    ideas: tools.ideas || [],
    graphics: tools.graphics || [],
    opengls: openGLView(tools.lwjgls || [], tools.graphics || []),
    scannedAt: stored.scannedAt || new Date().toISOString(),
    durationMs: stored.durationMs ?? null,
    roots: stored.roots || [],
    walk: stored.walk || null,
    cache: {
      file: meta.cacheFile || null,
      fromCache: !!meta.fromCache,
      ttlMs: meta.ttlMs ?? null,
      ageMs: stored.scannedAt ? ageMs(stored) : 0
    }
  };
}

function rootsCovered(requested, cached) {
  if (!requested.length) return true;
  const set = new Set((cached || []).map((r) => String(r).toLowerCase()));
  return requested.every((r) => set.has(String(r).toLowerCase()));
}

/**
 * Discover tools (cached).
 * @param {string[]|object} input tool roots array or options object
 * @param {boolean} forceRefresh
 */
export async function scanTools(input, forceRefresh = false) {
  const opts = normalizeOptions(input, forceRefresh);
  const cacheFile = cacheFileFor(opts);
  const key = JSON.stringify({
    roots: opts.toolRoots.map((r) => resolvePath(r)),
    deep: !!opts.deepScan,
    drives: opts.scanDrives !== false,
    cacheFile
  });

  if (!opts.refresh) {
    const hit = memory.get(key);
    if (hit && Date.now() - hit.at < opts.cacheTtlMs) {
      return shape(hit.data, { cacheFile, fromCache: true, ttlMs: opts.cacheTtlMs });
    }
    const stored = loadDiscovery(cacheFile);
    if (stored && ageMs(stored) < opts.cacheTtlMs && rootsCovered(opts.toolRoots, stored.roots)) {
      const validated = validateDiscovery(stored);
      memory.set(key, { data: validated, at: Date.now() });
      return shape(validated, { cacheFile, fromCache: true, ttlMs: opts.cacheTtlMs });
    }
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const run = (async () => {
    const data = discoverSync(opts);
    saveDiscovery(cacheFile, data);
    memory.set(key, { data, at: Date.now() });
    return shape(data, { cacheFile, fromCache: false, ttlMs: opts.cacheTtlMs });
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, run);
  return run;
}

/**
 * Startup helper: scan once, store the result, never throw.
 * @param {object} [options]
 */
export async function ensureDiscovery(options = {}) {
  const opts = normalizeOptions(options);
  const cacheFile = cacheFileFor(opts);
  const result = { cacheFile, fromCache: false, scannedAt: null, error: null, counts: null };
  try {
    const stored = loadDiscovery(cacheFile);
    if (stored && ageMs(stored) < opts.cacheTtlMs && rootsCovered(opts.toolRoots, stored.roots)) {
      const validated = validateDiscovery(stored);
      result.fromCache = true;
      result.scannedAt = validated.scannedAt;
      result.counts = countTools(validated.tools);
      return result;
    }
  } catch { /* fall through to a real scan */ }

  try {
    const data = await scanTools({ ...opts, refresh: true });
    result.scannedAt = data.scannedAt;
    result.counts = countTools(data);
    result.durationMs = data.durationMs;
  } catch (error) {
    result.error = String(error?.message || error);
  }
  return result;
}

export function countTools(tools) {
  return {
    jdks: (tools.jdks || []).length,
    gradles: (tools.gradles || []).length,
    androidSdks: (tools.androidSdks || []).length,
    ffmpegs: (tools.ffmpegs || []).length,
    lwjgls: (tools.lwjgls || []).length,
    ideas: (tools.ideas || []).length
  };
}

/** Inspect the stored discovery without scanning anything. */
export function discoveryStatus(options = {}) {
  const opts = normalizeOptions(options);
  const cacheFile = cacheFileFor(opts);
  const stored = loadDiscovery(cacheFile);
  if (!stored) {
    return { cacheFile, present: false, fresh: false, scannedAt: null, ageMs: null, counts: null, roots: [], walk: null };
  }
  const age = ageMs(stored);
  return {
    cacheFile,
    present: true,
    fresh: age < opts.cacheTtlMs,
    scannedAt: stored.scannedAt,
    ageMs: age,
    ttlMs: opts.cacheTtlMs,
    counts: countTools(stored.tools || {}),
    roots: stored.roots || [],
    walk: stored.walk || null,
    durationMs: stored.durationMs ?? null
  };
}

export function clearCache(options = {}) {
  memory.clear();
  inFlight.clear();
  const opts = normalizeOptions(options);
  return clearDiscovery(cacheFileFor(opts));
}

/**
 * Resolve the concrete toolchain a project should use.
 * @param {string} projectDir
 * @param {object} [options]
 */
export async function resolveProjectTools(projectDir, options = {}) {
  const opts = normalizeOptions(options);
  const tools = await scanTools(opts);
  const hints = readProjectHints(projectDir);
  const picked = selectTools(tools, hints);
  return {
    project: projectDir,
    ...picked,
    hints: {
      buildSystem: hints.buildSystem,
      javaMajor: hints.javaMajor,
      javaHome: hints.javaHome,
      sdkDir: hints.sdkDir,
      hasWrapper: hints.hasWrapper,
      gradleVersion: hints.gradleVersion,
      sources: hints.sources
    },
    allJdks: (tools.jdks || []).map((j) => ({ path: j.path, version: j.version, javaHome: j.javaHome, isGraal: j.isGraal, source: j.source })),
    discovery: {
      scannedAt: tools.scannedAt,
      fromCache: tools.cache?.fromCache ?? false,
      cacheFile: tools.cache?.file ?? null
    }
  };
}

/** Locate the best JDK without a project context (used by java_fix / java_apply). */
export async function bestJdk(options = {}) {
  const tools = await scanTools(options);
  const jdk = (tools.jdks || [])[0];
  return jdk || null;
}

export {
  readProjectHints, selectTools, majorOf, compareVersions, unescapeProperty,
  probeJdk, probeGradle, probeAndroidSdk, probeFfmpeg, probeLwjgl, probeIdea, probeEnvironment
};
export { versionFromName, dedupeBy } from './probe.js';
export { walkDirs };
export { standardRoots, fixedDrives, envToolRoots, cacheDir };
export { defaultCacheFile } from './store.js';
