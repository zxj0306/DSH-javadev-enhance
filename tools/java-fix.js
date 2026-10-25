/**
 * java_fix tool: deterministic auto-fixes for Java source files.
 */

import { autoFix } from '../core/fix/engine.js';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { defineTool } from './define.js';

export const schema = {
  name: 'java_fix',
  description: 'Apply deterministic Java fixes (imports, @Override, serialVersionUID, whitespace) to files or directories. Returns a compact summary, never the full file.',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'File or directory paths relative to the session cwd. Default: entire cwd.'
      },
      level: {
        type: 'string',
        enum: ['safe', 'all'],
        description: 'safe = only unique deterministic fixes (default); all = include opinionated fixes',
        default: 'safe'
      },
      dryRun: { type: 'boolean', description: 'Preview without writing', default: false },
      validate: { type: 'boolean', description: 'Run javac validation after fixes', default: true },
      toolRoots: { type: 'array', items: { type: 'string' }, description: 'Extra tool roots for javac lookup' }
    },
    additionalProperties: false
  }
};

function collectJavaFiles(targets) {
  const files = [];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    let st;
    try { st = statSync(target); } catch { continue; }
    if (st.isDirectory()) {
      for (const entry of readdirSync(target)) files.push(...collectJavaFiles([join(target, entry)]));
    } else if (target.endsWith('.java')) {
      files.push(target);
    }
  }
  return files;
}

export async function execute(args, exec) {
  const cwd = exec.agent?.session?.header?.cwd || process.cwd();
  const paths = Array.isArray(args.paths) && args.paths.length ? args.paths : ['.'];
  const level = args.level === 'all' ? 'all' : 'safe';
  const dryRun = args.dryRun === true;
  const validate = args.validate !== false;
  const toolRoots = Array.isArray(args.toolRoots) ? args.toolRoots : [];

  const targets = paths.map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
  const javaFiles = collectJavaFiles(targets);
  if (!javaFiles.length) return { ok: true, summary: 'No .java files found.', files: [], dryRun };

  const results = [];
  for (const file of javaFiles) {
    const content = readFileSync(file, 'utf8');
    const result = await autoFix(content, { toolRoots, level, dryRun, validate });
    if (!dryRun && result.success && result.applied.length > 0 && result.fixed !== content) {
      writeFileSync(file, result.fixed, 'utf8');
    }
    results.push({ path: file, applied: result.applied, errors: result.errors });
  }

  const changed = results.filter((r) => r.applied.length > 0);
  const errorCount = results.reduce((n, r) => n + r.errors.length, 0);
  return {
    ok: errorCount === 0,
    dryRun,
    summary: `${dryRun ? 'Preview' : 'Applied'} ${results.reduce((n, r) => n + r.applied.length, 0)} fix(es) in ${changed.length}/${results.length} file(s)${errorCount ? `, ${errorCount} error(s)` : ''}`,
    files: results.filter((r) => r.applied.length || r.errors.length)
  };
}

export function render(_args, value) {
  if (!value || (value.ok === false && !value.summary)) {
    return `java_fix error: ${value?.error?.message || 'unknown error'}`;
  }
  const lines = [value.summary];
  for (const file of value.files || []) {
    lines.push('', file.path);
    for (const a of file.applied) lines.push(`  - ${a.rule}: ${a.description}`);
    for (const e of file.errors) lines.push(`  - ERROR [${e.rule}]: ${e.error}`);
  }
  return lines.join('\n');
}

export const tool = defineTool({ ...schema, execute, render });
