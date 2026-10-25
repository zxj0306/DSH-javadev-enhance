/**
 * dsh-java-dev — Java efficient development plugin for DeepSeek Harness.
 *
 * Tools
 *  - java_fix        deterministic auto-fix (IDEA-style quick fixes, no model)
 *  - java_apply      intent + parameters -> generated Java (token saving)
 *  - java_apply_list template catalogue
 *  - java_env        JDK / Gradle / Android SDK / FFmpeg / OpenGL / IDEA paths
 *
 * Behaviour
 *  - writes/edits of `.java` files run the safe fix set automatically
 *  - a short system-prompt section steers models to java_apply templates
 */

import { tool as javaFix } from './tools/java-fix.js';
import { tool as javaApply, listTool as javaApplyList } from './tools/java-apply.js';
import { tool as javaEnv } from './tools/java-env.js';
import { autoFix } from './core/fix/engine.js';
import { ensureDiscovery, DEFAULT_CONFIG } from './core/env/index.js';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export const name = 'java-dev';
export const inject = ['tools'];

/**
 * Default configuration. Tool discovery needs no machine specific paths:
 * environment variables, PATH, standard install locations and drive roots are
 * searched automatically and the result is cached under the user's cache dir.
 */
const DEFAULTS = {
  toolRoots: [],
  autoDiscover: true,
  scanDrives: true,
  deepScan: false,
  cacheTtlMs: 6 * 60 * 60 * 1000,
  cacheFile: null,
  cacheDir: null,
  autoFix: 'safe',
  useIdeaFormatter: true
};

const WRITE_TOOLS = new Set(['write', 'edit', 'write_file', 'edit_file', 'ops_write_file', 'ops_edit_file']);

/** Discovery options derived from the plugin config. */
function discoveryOptions(config) {
  return {
    toolRoots: Array.isArray(config.toolRoots) ? config.toolRoots.map(String) : [],
    autoDiscover: config.autoDiscover !== false,
    scanDrives: config.scanDrives !== false,
    deepScan: config.deepScan === true,
    cacheTtlMs: Number(config.cacheTtlMs) > 0 ? Number(config.cacheTtlMs) : DEFAULT_CONFIG.cacheTtlMs,
    cacheFile: config.cacheFile || null,
    cacheDir: config.cacheDir || null
  };
}

/** @param {any} ctx @param {any} raw */
export function apply(ctx, raw = {}) {
  const config = { ...DEFAULTS, ...(raw || {}) };
  const toolRoots = Array.isArray(config.toolRoots) ? config.toolRoots.map(String) : [];
  const autoFixMode = config.autoFix === true ? 'safe' : String(config.autoFix || 'safe');

  ctx.effect(() => ctx.tools.register(javaFix), 'java-dev: java_fix');
  ctx.effect(() => ctx.tools.register(javaApply), 'java-dev: java_apply');
  ctx.effect(() => ctx.tools.register(javaApplyList), 'java-dev: java_apply_list');
  ctx.effect(() => ctx.tools.register(javaEnv), 'java-dev: java_env');

  // ---- automatic tool discovery on startup -------------------------------
  // Runs once per install/first session and caches the paths under the user's
  // cache directory, so later sessions do not rescan. Fire and forget: a slow
  // or failing scan must never delay the plugin from loading.
  if (config.autoDiscover !== false) {
    const options = discoveryOptions(config);
    ctx.effect(() => {
      const task = ensureDiscovery(options).catch(() => null);
      return () => { /* nothing to tear down; the scan aborts with the process */ };
    }, 'java-dev: tool discovery');
    Promise.resolve()
      .then(() => ensureDiscovery(options))
      .then((result) => {
        const logger = ctx.get?.('logger');
        if (logger && typeof logger.debug === 'function' && result && !result.error) {
          logger.debug(`[java-dev] tool discovery ${result.fromCache ? 'reused' : 'completed'} in ${result.durationMs ?? 0}ms: ${JSON.stringify(result.counts)}`);
        }
      })
      .catch(() => {});
  }

  // ---- auto-fix after any tool that wrote a .java file -------------------
  if (autoFixMode !== 'off') {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        const note = await maybeAutoFix(ctx, exec, config, toolRoots, autoFixMode);
        if (!note) return decision;
        if (decision.kind === 'accept') {
          const base = Array.isArray(decision.content) ? decision.content : result.content;
          const content = Array.isArray(base) ? base : [];
          return { ...decision, content: [...content, { type: 'text', text: note }] };
        }
      } catch {
        // never block the tool result because of a fix attempt
      }
      return decision;
    });
  }

  // ---- prompt guidance ---------------------------------------------------
  let promptService;
  try {
    promptService = ctx.get ? ctx.get('systemPrompt') : undefined;
  } catch {
    promptService = undefined;
  }
  if (promptService && typeof promptService.section === 'function') {
    ctx.effect(() => promptService.section({
      name: 'java-dev:guidance',
      order: 100,
      interpolate: false,
      text: () => JAVA_GUIDANCE
    }), 'java-dev: prompt section');
  }
}

/**
 * Run the safe fix set after a successful .java write.
 * @returns {Promise<string|null>} a one-line note for the tool result, or null
 */
async function maybeAutoFix(ctx, exec, config, toolRoots, mode) {
  if (!WRITE_TOOLS.has(String(exec?.name))) return null;
  const args = exec.arguments || {};
  const rawPath = args.file_path || args.path;
  if (typeof rawPath !== 'string' || !rawPath.endsWith('.java')) return null;

  const cwd = exec.agent?.session?.header?.cwd || process.cwd();
  const fullPath = resolve(cwd, rawPath);
  const rel = relative(resolve(cwd), fullPath);
  const insideWorkspace = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!insideWorkspace) return null;

  // Respect read-only sessions.
  let policyService;
  try {
    policyService = ctx.get ? ctx.get('sandboxPolicy') : undefined;
  } catch {
    policyService = undefined;
  }
  if (policyService && typeof policyService.resolve === 'function') {
    try {
      const policy = policyService.resolve({ session: exec.agent?.session });
      if (policy && policy.mode === 'read-only') return null;
    } catch {
      return null;
    }
  }

  if (!existsSync(fullPath)) return null;
  const st = statSync(fullPath);
  if (!st.isFile() || st.size > 512 * 1024) return null;

  const content = readFileSync(fullPath, 'utf8');
  const fixed = await autoFix(content, { toolRoots, level: mode, dryRun: false, validate: true });
  if (!fixed.applied.length || fixed.fixed === content) return null;

  writeFileSync(fullPath, fixed.fixed, 'utf8');
  return `[java-autofix] ${fixed.applied.map((a) => a.description).join('; ')}`;
}

const JAVA_GUIDANCE = `## Java workflow (dsh-java-dev)

Prefer \`java_apply\` over writing whole Java files. Two forms, both token-cheap:

1. Minimal intent (one word preset):
{"path":"src/main/java/com/x/User.java","intent":"pojo","name":"User",
 "fields":[["Long","id"],["String","name"]]}

   Presets: pojo, immutable, record, recordBuilder, dto, entity, service, controller,
   repository, test, singleton, exception, main, enum, interface, annotation, sealed,
   config, activity, util, constant, benchmark, ringbuf, objectpool, soa, mat4,
   gameloop, framebuffer, parallel, arena, lwjgl, noise.

2. Granular ops when you need exact control:
{"path":"...","ops":{"class":"public User","fields":["Long id","String name"],
  "getters":{},"setters":{},"equalsHashCode":{},"toString":{},"logger":{}}}
   Ops: class/interface/record/enum/annotation (object or shorthand string), fields,
   methods, constructors, getters, setters, builder, singleton, compactConstructor,
   equalsHashCode, toString, logger, javadoc, imports, annotations, main.

After any \`.java\` write/edit, safe deterministic fixes run automatically (unused and
duplicate normal imports, missing unique imports, @Override, serialVersionUID, import
order, trailing newline). Static imports and wildcard imports are never removed.
Use \`java_fix\` for batch or preview runs, and \`java_env\` to locate JDK, Gradle,
Android SDK, FFmpeg, LWJGL/OpenGL and the IDEA formatter.`;

export { autoFix };
