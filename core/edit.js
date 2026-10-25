/**
 * Text editing primitives for Java source.
 * Provides safe insertion, deletion, and replacement with position tracking.
 */

import { getLineCol, maskNonCode } from './java-source.js';

/**
 * Edit operation
 * @typedef {Object} EditOp
 * @property {number} start - Start position (inclusive)
 * @property {number} end - End position (exclusive)
 * @property {string} newText - Replacement text
 * @property {string} [description] - Human-readable description
 */

/**
 * Apply multiple edits to content, sorted by position descending to avoid index shifts
 * @param {string} content
 * @param {EditOp[]} edits
 * @returns {string}
 */
export function applyEdits(content, edits) {
  if (!edits.length) return content;
  // Sort by start descending so earlier edits don't shift later positions
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = content;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > result.length || edit.start > edit.end) {
      throw new Error(`Invalid edit range: ${edit.start}-${edit.end} (len=${result.length})`);
    }
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

/**
 * Create an insertion edit
 * @param {number} pos - Position to insert at
 * @param {string} text - Text to insert
 * @param {string} [desc]
 * @returns {EditOp}
 */
export function insert(pos, text, desc) {
  return { start: pos, end: pos, newText: text, description: desc };
}

/**
 * Create a deletion edit
 * @param {number} start
 * @param {number} end
 * @param {string} [desc]
 * @returns {EditOp}
 */
export function remove(start, end, desc) {
  return { start, end, newText: '', description: desc };
}

/**
 * Create a replacement edit
 * @param {number} start
 * @param {number} end
 * @param {string} newText
 * @param {string} [desc]
 * @returns {EditOp}
 */
export function replace(start, end, newText, desc) {
  return { start, end, newText, description: desc };
}

/**
 * Find import section end position (after last import, before type declarations)
 * @param {string} content
 * @param {object} parsed - Result from parseJavaSource
 * @returns {number} Position to insert new imports
 */
export function findImportInsertPos(content, parsed) {
  // After last import statement (static and wildcard forms included)
  const importMatches = [...content.matchAll(/^\s*import\s+(?:static\s+)?[\w.]+(?:\.\*)?\s*;/gm)];
  if (importMatches.length > 0) {
    const lastImport = importMatches[importMatches.length - 1];
    return lastImport.index + lastImport[0].length;
  }
  // After package statement
  const pkgMatch = content.match(/^\s*package\s+[\w.]+\s*;/m);
  if (pkgMatch) {
    return pkgMatch.index + pkgMatch[0].length;
  }
  // At beginning (after any leading comments/whitespace)
  const firstNonWs = content.search(/\S/);
  return firstNonWs >= 0 ? firstNonWs : 0;
}

/**
 * All import statements with their exact source spans.
 * Handles `import static`, wildcard imports and trailing whitespace.
 * @param {string} content
 * @returns {Array<{start:number,end:number,text:string,isStatic:boolean,path:string,isWildcard:boolean}>}
 */
export function parseImports(content) {
  const re = /^([ \t]*)import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;[ \t]*$/gm;
  const imports = [];
  for (const m of content.matchAll(re)) {
    const start = m.index;
    let end = start + m[0].length;
    if (content[end] === '\n') end++;
    else if (content[end] === '\r' && content[end + 1] === '\n') end += 2;
    imports.push({
      start,
      end,
      text: content.slice(start, start + m[0].length),
      isStatic: Boolean(m[2]),
      path: m[3],
      isWildcard: m[3].endsWith('.*')
    });
  }
  return imports;
}

/**
 * Check whether a normal (non-static) import, or a wildcard covering it, exists.
 * Static and wildcard imports are never treated as satisfying a type import.
 * @param {string} content
 * @param {string} importPath - e.g. "java.util.List"
 * @returns {boolean}
 */
export function hasImport(content, importPath) {
  const pkg = importPath.includes('.') ? importPath.slice(0, importPath.lastIndexOf('.')) : '';
  for (const imp of parseImports(content)) {
    if (imp.isStatic) continue;
    if (!imp.isWildcard && imp.path === importPath) return true;
    if (imp.isWildcard && imp.path.slice(0, -2) === pkg) return true;
  }
  return false;
}

/**
 * Remove unused imports.
 * Conservative by design: static imports and wildcard imports are never removed
 * (their usage cannot be proven lexically), and Javadoc {@link} references count
 * as usage.
 * @param {string} content
 * @param {object} parsed
 * @returns {{content:string, removed:string[], edits:EditOp[]}}
 */
export function removeUnusedImports(content, parsed) {
  const imports = parseImports(content);
  const usedNames = new Set();

  // Identifiers in real code (comments/strings masked out).
  const code = maskNonCode(content);
  const importSpans = imports.map((imp) => [imp.start, imp.end]);
  const isInsideImport = (pos) => importSpans.some(([s, e]) => pos >= s && pos < e);
  for (const m of code.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    if (isInsideImport(m.index)) continue;
    usedNames.add(m[0]);
  }
  // Javadoc references: {@link Foo}, {@link Foo#bar}, @see Foo, @throws Foo.
  for (const m of content.matchAll(/\{@(?:link|linkplain|see|value)\s+([\w.$#]+)|@(?:see|throws|exception)\s+([\w.$#]+)/g)) {
    const ref = m[1] || m[2];
    if (ref) usedNames.add(ref.split(/[#.]/).pop());
  }
  for (const m of parsed.methods || []) usedNames.add(m.name);
  for (const f of parsed.fields || []) usedNames.add(f.name);
  for (const t of parsed.types || []) usedNames.add(t.name);

  const edits = [];
  const removed = [];
  for (const imp of imports) {
    if (imp.isStatic || imp.isWildcard) continue;
    const simpleName = imp.path.split('.').pop();
    if (usedNames.has(simpleName)) continue;
    edits.push(remove(imp.start, imp.end, `Remove unused import ${imp.path}`));
    removed.push(imp.path);
  }
  return {
    content: applyEdits(content, edits),
    removed,
    edits
  };
}

/**
 * Add import if not present
 * @param {string} content
 * @param {string} importPath
 * @param {object} parsed
 * @returns {{content:string, added:boolean, edit?:EditOp}}
 */
export function addImport(content, importPath, parsed) {
  if (hasImport(content, importPath)) {
    return { content, added: false };
  }
  const pos = findImportInsertPos(content, parsed);
  const before = pos > 0 ? content[pos - 1] : '\n';
  const after = content[pos] || '\n';
  const lead = before === '\n' ? '' : '\n';
  const trail = after === '\n' ? '' : '\n';
  const importLine = `${lead}import ${importPath};${trail}`;
  const edit = insert(pos, importLine, `Add import ${importPath}`);
  return {
    content: applyEdits(content, [edit]),
    added: true,
    edit
  };
}

/**
 * Normalize line endings to LF (but track original)
 * @param {string} content
 * @returns {{content:string, originalEol:string}}
 */
export function normalizeEol(content) {
  const hasCrlf = content.includes('\r\n');
  return {
    content: content.replace(/\r\n/g, '\n'),
    originalEol: hasCrlf ? '\r\n' : '\n'
  };
}

/**
 * Restore original line endings
 * @param {string} content
 * @param {string} eol
 * @returns {string}
 */
export function restoreEol(content, eol) {
  if (eol === '\r\n') {
    return content.replace(/\n/g, '\r\n');
  }
  return content;
}

/**
 * Ensure file ends with single newline
 * @param {string} content
 * @param {string} eol
 * @returns {string}
 */
export function ensureFinalNewline(content, eol = '\n') {
  if (!content.endsWith(eol)) return content + eol;
  // Remove extra trailing newlines
  let trimmed = content;
  while (trimmed.endsWith(eol + eol)) {
    trimmed = trimmed.slice(0, -eol.length);
  }
  return trimmed;
}

/**
 * Convert tabs to spaces (4 spaces per tab)
 * @param {string} content
 * @returns {string}
 */
export function tabsToSpaces(content) {
  return content.replace(/\t/g, '    ');
}

/**
 * Check if position is in string or comment (copy from java-source for independence)
 * @param {string} content
 * @param {number} pos
 * @returns {boolean}
 */
function inStringOrComment(content, pos) {
  let inString = false, inChar = false, inComment = false, inLineComment = false, escape = false;
  for (let i = 0; i < pos && i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inComment) { if (ch === '*' && content[i+1] === '/') { inComment = false; i++; } continue; }
    if (ch === '/' && content[i+1] === '/') { inLineComment = true; continue; }
    if (ch === '/' && content[i+1] === '*') { inComment = true; i++; continue; }
    if (ch === '"' && !inChar) { inString = !inString; continue; }
    if (ch === "'" && !inString) { inChar = !inChar; continue; }
  }
  return inString || inChar || inComment || inLineComment;
}

export { inStringOrComment };