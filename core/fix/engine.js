/**
 * Auto-fix engine: applies fix rules to Java source files.
 * Integrates with javac for validation.
 */

import { parseJavaSource } from '../java-source.js';
import { checkJavaSource, compilesClean } from '../javac.js';
import { applyEdits, normalizeEol, restoreEol, ensureFinalNewline } from '../edit.js';
import { SAFE_RULES, ALL_RULES } from './rules.js';

/**
 * Apply fix rules to content
 * @param {string} content
 * @param {object} options
 * @param {string[]} options.toolRoots
 * @param {'safe'|'all'} options.level
 * @param {boolean} options.dryRun
 * @returns {Promise<{success:boolean, original:string, fixed:string, applied:Array, errors:Array, summary:string}>}
 */
async function autoFix(content, options = {}) {
  const { toolRoots = [], level = 'safe', dryRun = false } = options;
  const rules = level === 'all' ? ALL_RULES : SAFE_RULES;

  const originalContent = content;
  let currentContent = content;
  const applied = [];
  const errors = [];
  let needsValidation = false;

  let parsed = parseJavaSource(currentContent);

  for (const rule of rules) {
    try {
      const result = await rule.fn(currentContent, parsed, { toolRoots, ...options });
      if (!result.applied) continue;
      if (result.content !== undefined && result.content !== currentContent) {
        // Rule produced the full new content itself (e.g. javac-verified imports).
        currentContent = result.content;
        applied.push({ rule: rule.name, description: result.description, edits: 0 });
      } else if (result.edits.length > 0) {
        currentContent = applyEdits(currentContent, result.edits);
        applied.push({ rule: rule.name, description: result.description, edits: result.edits.length });
      } else {
        continue;
      }
      if (result.requiresJavac) needsValidation = true;
      parsed = parseJavaSource(currentContent);
    } catch (err) {
      errors.push({ rule: rule.name, error: err.message });
    }
  }

  if (currentContent === originalContent) {
    return {
      success: true,
      original: originalContent,
      fixed: currentContent,
      applied,
      errors,
      summary: 'No changes needed'
    };
  }

  // A javac-verified rule already proved its own fix. Only guard against a
  // regression (new compile errors), never require the project to compile
  // standalone — that would revert valid fixes in files with project deps.
  if (!dryRun && needsValidation && options.validate !== false) {
    const before = await checkJavaSource(originalContent, { toolRoots });
    const after = await checkJavaSource(currentContent, { toolRoots });
    if (before.error === undefined && after.error === undefined && after.errors > before.errors) {
      errors.push({ rule: 'validation', error: `Fix introduced ${after.errors - before.errors} new compiler error(s)` });
      currentContent = originalContent;
      applied.length = 0;
    }
  }

  const summary = applied.length > 0
    ? `${applied.length} fix(es) applied: ${applied.map(a => a.description).join('; ')}`
    : 'No changes';

  return {
    success: errors.length === 0,
    original: originalContent,
    fixed: currentContent,
    applied,
    errors,
    summary
  };
}

/**
 * Fix a single file
 * @param {string} filePath
 * @param {object} options
 * @returns {Promise<object>}
 */
async function fixFile(filePath, options = {}) {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { dryRun = false } = options;
  if (!existsSync(filePath)) {
    return { success: false, error: 'File not found', filePath };
  }
  const content = readFileSync(filePath, 'utf8');
  const result = await autoFix(content, options);
  if (!dryRun && result.success && result.applied.length > 0) {
    writeFileSync(filePath, result.fixed, 'utf8');
  }
  return { ...result, filePath };
}

/**
 * Fix multiple files
 * @param {string[]} filePaths
 * @param {object} options
 * @returns {Promise<Array>}
 */
async function fixFiles(filePaths, options = {}) {
  const results = [];
  for (const filePath of filePaths) {
    results.push(await fixFile(filePath, options));
  }
  return results;
}

/**
 * Fix all .java files in a directory
 * @param {string} dirPath
 * @param {object} options
 * @returns {Promise<Array>}
 */
async function fixDirectory(dirPath, options = {}) {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const files = [];
  function scan(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) scan(full);
      else if (entry.endsWith('.java')) files.push(full);
    }
  }
  scan(dirPath);

  return fixFiles(files, options);
}

export { autoFix, fixFile, fixFiles, fixDirectory };
