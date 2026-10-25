/**
 * Bounded, pruned directory walker used by the tool discovery.
 *
 * Goals: never hang on huge trees (node_modules, WinSxS, network shares),
 * always terminate within a time / directory budget, and still reach tool
 * collections that live a few levels deep (`D:\env\jdk21`,
 * `~/dev/tools/gradle-8.7`).
 *
 * Strategy
 *  - depth 0..2: every sub-directory is read (cheap: one readdir each)
 *  - depth >= 3: only descend into directories whose name looks like a tool
 *    container, so `<drive>\projects\**` is not crawled
 */

import { join } from 'node:path';
import { readDirEntries } from './platform.js';

/** Directory names that are never useful for tool discovery. */
const PRUNE = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '.npm', '.pnpm-store', '.yarn',
  'windows', 'winsxs', 'system32', 'syswow64', '$recycle.bin', 'system volume information',
  'config.msi', 'recovery', 'perflogs', 'temp', 'tmp', 'tmpdir', 'caches', 'cache2',
  'msdownload', 'driverstore', 'installer', 'packages', 'logs', 'crashdumps', 'webcache',
  'site-packages', 'dist-packages', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  'debug', 'release', '.gradle', '.idea', '.vs', '.vscode', '.m2', 'vendor'
]);

/** Names that deserve a deeper look. */
const INTERESTING = /jdk|java|jre|jvm|graal|gradle|maven|android|sdk|ndk|adb|lwjgl|opengl|vulkan|ffmpeg|idea|intellij|jetbrains|toolchain|tools?|environment|\benv\b|dev|program|software|apps?|scoop|sdkman|homebrew|cellar|opt|libs?|runtime|platform/i;

/** Depth at which we stop walking unconditionally and require an interesting name. */
const FREE_DEPTH = 2;

function isInteresting(name) {
  return INTERESTING.test(name);
}

export function isPruned(name) {
  return PRUNE.has(name.toLowerCase());
}

/**
 * @param {string[]} roots starting directories
 * @param {object} opts
 * @param {(dir:string, depth:number)=>void} [opts.onDir] called for every visited directory
 * @param {number} [opts.maxDepth=4]
 * @param {number} [opts.budget=1200] max directories visited
 * @param {number} [opts.timeBudgetMs=2500]
 * @param {string[]} [opts.exclude] extra basenames to skip
 * @returns {{visited:number, truncated:boolean, roots:string[]}}
 */
export function walkDirs(roots, opts = {}) {
  const {
    onDir,
    maxDepth = 4,
    budget = 1200,
    timeBudgetMs = 2500,
    exclude = []
  } = opts;

  const started = Date.now();
  const excluded = new Set(exclude.map((s) => String(s).toLowerCase()));
  const seen = new Set();
  const usedRoots = [];
  const stack = [];
  let visited = 0;
  let truncated = false;

  for (const raw of roots) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const dir = raw.replace(/[\\/]+$/, '') || raw;
    if (seen.has(dir)) continue;
    seen.add(dir);
    usedRoots.push(dir);
    stack.push({ dir, depth: 0 });
  }

  while (stack.length) {
    if (visited >= budget || Date.now() - started > timeBudgetMs) {
      truncated = true;
      break;
    }
    const { dir, depth } = stack.pop();
    visited += 1;
    try { onDir?.(dir, depth); } catch { /* visitor errors must not stop the walk */ }
    if (depth >= maxDepth) continue;

    for (const entry of readDirEntries(dir)) {
      const name = entry.name;
      if (!name) continue;
      const lower = name.toLowerCase();
      if (PRUNE.has(lower) || excluded.has(lower)) continue;
      // Skip symlinks/junctions: they can create cycles or reach the network.
      if (!entry.isDirectory()) continue;
      if (depth + 1 > FREE_DEPTH && !isInteresting(name)) continue;
      stack.push({ dir: join(dir, name), depth: depth + 1 });
    }
  }

  return { visited, truncated, roots: usedRoots };
}
