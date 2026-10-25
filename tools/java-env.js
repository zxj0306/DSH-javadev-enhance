/**
 * java_env tool: automatic, cross-platform discovery of Java development tools.
 */

import {
  scanTools, resolveProjectTools, ensureDiscovery, discoveryStatus, clearCache
} from '../core/env/index.js';
import { resolve, isAbsolute } from 'node:path';
import { defineTool } from './define.js';

const WHICH = ['jdk', 'gradle', 'android-sdk', 'ffmpeg', 'opengl', 'idea'];

export const schema = {
  name: 'java_env',
  description:
    'Locate Java development tools on this machine (JDK, Gradle, Android SDK, FFmpeg, LWJGL/OpenGL, IDEA formatter) '
    + 'and resolve the ones a given project should use. Discovery is automatic and cross-platform: it checks '
    + 'environment variables, PATH, standard install locations and drive roots, then caches the result in the user '
    + 'cache directory. Never hard-coded to one machine.',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project directory relative to session cwd (default: cwd).' },
      which: {
        type: 'array',
        items: { type: 'string', enum: [...WHICH, 'all'] },
        description: 'Restrict the report to specific tools (default: all).'
      },
      mode: {
        type: 'string',
        enum: ['project', 'all', 'status'],
        description:
          "project (default): resolve the toolchain for `project`; all: list every detected installation; "
          + 'status: report the stored discovery file without scanning.'
      },
      deep: { type: 'boolean', description: 'Deeper/slower filesystem scan (bigger budget).', default: false },
      refresh: { type: 'boolean', description: 'Ignore the stored discovery result and scan again.', default: false },
      clearCache: { type: 'boolean', description: 'Delete the stored discovery result before answering.', default: false },
      toolRoots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra roots to scan (e.g. a tools directory). Environment variables and standard locations are always used.'
      },
      listAll: { type: 'boolean', description: 'Alias for mode=all.', default: false }
    },
    additionalProperties: false
  }
};

export async function execute(args, exec) {
  const cwd = exec.agent?.session?.header?.cwd || process.cwd();
  const projectDir = args.project ? (isAbsolute(args.project) ? args.project : resolve(cwd, args.project)) : cwd;
  const which = Array.isArray(args.which) && args.which.length ? args.which : [];
  const refresh = args.refresh === true;
  const toolRoots = Array.isArray(args.toolRoots) ? args.toolRoots : [];
  const options = { toolRoots, refresh, deepScan: args.deep === true };
  const listAll = args.listAll === true || which.includes('all');
  const mode = args.mode || (listAll ? 'all' : 'project');

  if (args.clearCache === true) clearCache(options);

  if (mode === 'status') {
    const status = discoveryStatus(options);
    return { ok: true, mode: 'status', status, project: projectDir, ...(status.present ? await refreshCounts(options) : {}) };
  }

  if (mode === 'all') {
    const tools = await scanTools(options);
    return { ok: true, mode: 'all', which, tools, project: projectDir };
  }

  const tools = await resolveProjectTools(projectDir, options);
  const wanted = which.filter((w) => w !== 'all');
  if (wanted.length) {
    const filtered = { ...tools };
    for (const key of ['jdk', 'gradle', 'androidSdk', 'ffmpeg', 'formatter']) {
      if (!wanted.some((w) => matchesWhich(w, key))) delete filtered[key];
    }
    if (!wanted.includes('opengl')) delete filtered.opengl;
    return { ok: true, mode: 'project', which, tools: filtered, project: projectDir };
  }
  return { ok: true, mode: 'project', tools, project: projectDir };
}

function matchesWhich(which, key) {
  if (key === 'androidSdk') return which === 'android-sdk';
  if (key === 'formatter') return which === 'idea';
  return which === key;
}

async function refreshCounts(options) {
  try {
    const discovery = await ensureDiscovery(options);
    return { discovery };
  } catch {
    return {};
  }
}

export function render(_args, value) {
  if (!value) return 'java_env: no result';
  if (value.ok === false) return `java_env error: ${value.error?.message || 'unknown'}`;

  if (value.mode === 'status') {
    return renderStatus(value.status, value.discovery);
  }

  if (value.mode === 'all') {
    const t = value.tools || {};
    const want = (k) => !value.which?.length || value.which.includes('all') || value.which.includes(k);
    const lines = ['Detected tool installations:'];
    const jdks = t.jdks || [];
    const gradles = t.gradles || [];
    const sdks = t.androidSdks || [];
    const ffmpegs = t.ffmpegs || [];
    const lwjgls = t.lwjgls || [];
    const ideas = t.ideas || [];

    if (want('jdk') && jdks.length) {
      lines.push('', 'JDKs:');
      for (const j of jdks) lines.push(`  - ${j.version} ${j.javaHome}${j.isGraal ? ' (GraalVM)' : ''}${j.source ? ` [${j.source}]` : ''}`);
    }
    if (want('gradle') && gradles.length) {
      lines.push('', 'Gradle:');
      for (const g of gradles) lines.push(`  - ${g.version} ${g.path}${g.source ? ` [${g.source}]` : ''}`);
    }
    if (want('android-sdk') && sdks.length) {
      lines.push('', 'Android SDK:');
      for (const s of sdks) lines.push(`  - ${s.path} platforms=[${(s.platforms || []).join(',')}] buildTools=[${(s.buildTools || []).join(',')}] adb=${s.adb || 'none'}`);
    }
    if (want('ffmpeg') && ffmpegs.length) {
      lines.push('', 'FFmpeg:');
      for (const f of ffmpegs) lines.push(`  - ${f.version} ${f.path}`);
    }
    if (want('opengl') && lwjgls.length) {
      lines.push('', 'LWJGL/OpenGL:');
      for (const l of lwjgls) lines.push(`  - ${l.displayName} (${l.lwjgl.length} jars, ${l.natives.length} natives${l.version ? `, ${l.version}` : ''})`);
    }
    if (want('opengl') && (t.graphics || []).length) {
      lines.push('', 'System graphics:');
      for (const g of t.graphics || []) lines.push(`  - ${g.kind}: ${g.path}`);
    }
    if (want('idea') && ideas.length) {
      lines.push('', 'IntelliJ IDEA:');
      for (const i of ideas) lines.push(`  - ${i.version} ${i.path}${i.formatter ? ` formatter=${i.formatter}` : ''}`);
    }
    if (lines.length === 1) {
      lines.push('  (none found — set JAVA_HOME / ANDROID_HOME / GRADLE_HOME or pass toolRoots, then retry with refresh)');
    }
    const c = t.cache || {};
    if (c.file) lines.push('', `cache: ${c.file}${c.fromCache ? ' (reused)' : ' (rescanned)'}`);
    return lines.join('\n');
  }

  const t = value.tools || {};
  const lines = [`Project tools for ${value.project}:`];
  if ('jdk' in t) {
    const jdk = t.jdk || {};
    lines.push(jdk.missing ? 'JDK: NOT FOUND' : `JDK: ${jdk.version} ${jdk.javaHome || jdk.path}${jdk.isGraal ? ' (GraalVM)' : ''}`);
  }
  if ('gradle' in t) {
    const gradle = t.gradle || {};
    lines.push(gradle.missing ? 'Gradle: NOT FOUND' : `Gradle: ${gradle.version} ${gradle.path}${gradle.gradleHome ? ` (home ${gradle.gradleHome})` : ''}`);
  }
  if ('androidSdk' in t) {
    const sdk = t.androidSdk || {};
    lines.push(sdk.missing
      ? 'Android SDK: NOT FOUND'
      : `Android SDK: ${sdk.path} (${sdk.source || 'auto'}) platforms=[${(sdk.platforms || []).join(',')}] buildTools=[${(sdk.buildTools || []).join(',')}] adb=${sdk.adb || 'none'}`);
  }
  if ('ffmpeg' in t) {
    const ff = t.ffmpeg || {};
    lines.push(ff.missing ? 'FFmpeg: NOT FOUND' : `FFmpeg: ${ff.version} ${ff.path}`);
  }
  if ('formatter' in t) {
    const fmt = t.formatter || {};
    lines.push(fmt.missing ? 'IDEA formatter: NOT FOUND' : `IDEA formatter: ${fmt.version} ${fmt.idea}`);
  }
  if (t.opengl && !t.opengl.missing) {
    lines.push('OpenGL/LWJGL:', ...t.opengl.map((o) => {
      if (o.project) return `  - ${o.project} (${(o.lwjgl || []).length} jars, ${(o.natives || []).length} natives)`;
      if (o.system) return `  - system ${o.system}`;
      if (o.vulkan) return `  - vulkan ${o.vulkan}`;
      return '  - ?';
    }));
  }
  if (t.hints?.sources?.length) lines.push(`hints: ${t.hints.sources.join(', ')}`);
  if (t.discovery?.cacheFile) lines.push(`cache: ${t.discovery.cacheFile}${t.discovery.fromCache ? ' (reused)' : ' (rescanned)'}`);
  return lines.join('\n');
}

function renderStatus(status, discovery) {
  if (!status || !status.present) {
    return [
      'Discovery: no stored result yet.',
      status?.cacheFile ? `cache file: ${status.cacheFile}` : '',
      'Run java_env with {"mode":"all","refresh":true} to scan now.'
    ].filter(Boolean).join('\n');
  }
  const counts = status.counts || {};
  const ageMin = Math.round((status.ageMs || 0) / 60000);
  return [
    'Discovery cache:',
    `  file: ${status.cacheFile}`,
    `  scannedAt: ${status.scannedAt} (${ageMin} min ago, ${status.fresh ? 'fresh' : 'stale'})`,
    `  tools: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    status.roots?.length ? `  roots: ${status.roots.slice(0, 8).join(', ')}${status.roots.length > 8 ? ` …(+${status.roots.length - 8})` : ''}` : '',
    status.walk ? `  walk: ${status.walk.visited} dirs${status.walk.truncated ? ' (truncated by budget — use "deep":true for more)' : ''}` : '',
    discovery?.error ? `  last scan error: ${discovery.error}` : ''
  ].filter(Boolean).join('\n');
}

export const tool = defineTool({ ...schema, execute, render });
export { scanTools, resolveProjectTools, ensureDiscovery, discoveryStatus };
