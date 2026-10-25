/**
 * Lightweight Java source structure indexer.
 * Comments and string/char literals are masked (same length) before scanning,
 * so positions map 1:1 back to the original text and structural scanning is safe.
 */

const TYPE_KEYWORDS = ['class', 'interface', 'enum', 'record', '@interface'];

/**
 * Mask comments, strings and chars with spaces, preserving offsets and newlines.
 * @param {string} text
 * @returns {string}
 */
export function maskNonCode(text) {
  const out = text.split('');
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    const next = out[i + 1];
    if (ch === '/' && next === '/') {
      while (i < out.length && out[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (ch === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < out.length && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < out.length) { out[i] = ' '; out[i + 1] = ' '; }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i] = ' ';
      i++;
      while (i < out.length) {
        if (out[i] === '\\') { out[i] = ' '; if (i + 1 < out.length && out[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
        if (out[i] === quote) { out[i] = ' '; i++; break; }
        if (out[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

const BRACE_PAIRS = { '{': '}', '[': ']', '(': ')' };

/**
 * Find the matching closing bracket for the opening bracket at `startIdx`.
 * @param {string} text
 * @param {number} startIdx
 * @returns {number} index of the matching close, or -1
 */
export function findMatchingBrace(text, startIdx) {
  const open = text[startIdx];
  const close = BRACE_PAIRS[open];
  if (!close) return -1;
  let depth = 1;
  for (let i = startIdx + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract brace blocks with a rough owner description.
 * @param {string} text
 * @returns {Array<{type:string, start:number, end:number, name?:string}>}
 */
export function extractBlocks(text) {
  const code = maskNonCode(text);
  const blocks = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '{') continue;
    const end = findMatchingBrace(code, i);
    if (end < 0) continue;
    const before = code.slice(Math.max(0, i - 200), i);
    let type = 'block';
    let name;
    const classMatch = before.match(/\b(class|interface|enum|record)\s+(\w+)\s*(?:\([^)]*\))?\s*(?:extends[^{]*|implements[^{]*)?$/);
    if (classMatch) { type = classMatch[1]; name = classMatch[2]; }
    else {
      const methodMatch = before.match(/\b(\w+)\s*\([^)]*\)\s*(?:throws[^{]*)?$/);
      if (methodMatch) { type = 'method'; name = methodMatch[1]; }
    }
    blocks.push({ type, start: i, end, name });
    i = end;
  }
  return blocks;
}

/**
 * Parse a member type string like `List<String>[]` roughly (keeps generic text).
 * @param {string} raw
 * @returns {string}
 */
function cleanType(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Parse Java source into a structure index.
 * @param {string} content
 * @param {string} [filePath]
 * @returns {object}
 */
export function parseJavaSource(content, filePath = '') {
  const code = maskNonCode(content);
  const result = {
    filePath,
    package: '',
    imports: [],
    staticImports: [],
    types: [],
    methods: [],
    fields: [],
    annotations: [],
    blocks: [],
    lineCount: content.split('\n').length
  };

  const pkg = code.match(/^\s*package\s+([\w.]+)\s*;/m);
  if (pkg) result.package = pkg[1];

  const importRe = /^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    if (m[1]) result.staticImports.push(m[2]);
    else result.imports.push(m[2]);
  }

  // Type declarations
  const typeRe = /\b(class|interface|enum|record|@interface)\s+(\w+)/g;
  while ((m = typeRe.exec(code)) !== null) {
    const keyword = m[1];
    const name = m[2];
    const start = m.index;
    const braceIdx = code.indexOf('{', m.index);
    if (braceIdx < 0) continue;
    const end = findMatchingBrace(code, braceIdx);
    if (end < 0) continue;
    const type = {
      name,
      keyword,
      start,
      braceStart: braceIdx,
      bodyStart: braceIdx + 1,
      bodyEnd: end,
      end
    };
    if (keyword === 'record') {
      // record header components: between the record name and the opening brace
      const header = code.slice(m.index + m[0].length, braceIdx);
      const parenStart = header.indexOf('(');
      if (parenStart >= 0) {
        const parenEnd = header.lastIndexOf(')');
        if (parenEnd > parenStart) {
          const comps = header.slice(parenStart + 1, parenEnd).split(',').map((s) => s.trim()).filter(Boolean);
          type.components = comps.map((c) => {
            const cleaned = c.replace(/\s*@[\w.]+(?:\([^)]*\))?\s*/g, ' ').trim();
            const parts = cleaned.split(/\s+/);
            return { type: parts.slice(0, -1).join(' '), name: parts[parts.length - 1] };
          });
        }
      }
    }
    result.types.push(type);
  }

  // Methods (includes constructors). A member starts at file start or after `;`, `{`, `}` or a newline.
  const methodRe = /(?:^|(?<=[;{}\n]))[ \t]*((?:@[\w.]+(?:\([^)]*\))?\s*)*)((?:(?:public|protected|private|static|final|abstract|default|synchronized|native|strictfp)\s+)*)((?:<[^>]+>\s*)?)([\w.$<>\[\],? ]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*[{;]/g;
  while ((m = methodRe.exec(code)) !== null) {
    const name = m[5];
    if (TYPE_KEYWORDS.includes(name)) continue;
    if (!m[0].trimEnd().endsWith('{')) continue; // abstract / interface method without a body
    const start = m.index + (m[0].match(/^[\s]*/)[0].length);
    const braceIdx = code.lastIndexOf('{', m.index + m[0].length - 1);
    if (braceIdx < 0) continue;
    const end = findMatchingBrace(code, braceIdx);
    if (end < 0) continue;
    // Must be a direct member of a type body
    const owner = result.types.find((t) => start > t.bodyStart && end < t.bodyEnd);
    if (!owner) continue;
    if (result.methods.some((x) => x.start === start)) continue;
    result.methods.push({
      name,
      start,
      braceStart: braceIdx,
      end,
      owner: owner.name,
      modifiers: (m[2] || '').trim().split(/\s+/).filter(Boolean),
      annotations: [...(m[1] || '').matchAll(/@([\w.]+)/g)].map((x) => x[1]),
      returnType: cleanType(m[4] || ''),
      params: m[6] ? m[6].split(',').map((p) => p.trim()).filter(Boolean) : []
    });
  }

  // Constructors are methods whose name equals the owner type; keep them in methods too.
  for (const fn of result.methods) {
    if (result.types.some((t) => t.name === fn.name)) fn.isConstructor = true;
  }

  // Fields (member level; a member starts at file start or after `;`, `{`, `}` or a newline)
  const fieldRe = /(?:^|(?<=[;{}\n]))[ \t]*((?:@[\w.]+(?:\([^)]*\))?[ \t]*)*)((?:(?:public|protected|private|static|final|transient|volatile)[ \t]+)*)([\w.$<>\[\],? ]+?)[ \t]+(\w+)[ \t]*(?:=[^;]*)?;/g;
  while ((m = fieldRe.exec(code)) !== null) {
    const name = m[4];
    if (['return', 'new', 'throw', 'else'].includes(name)) continue;
    const lead = m[0].match(/^[ \t]*/)[0].length;
    const start = m.index + lead;
    const end = m.index + m[0].length;
    const owner = result.types.find((t) => start > t.bodyStart && end < t.bodyEnd);
    if (!owner) continue;
    if (result.methods.some((x) => start >= x.start && start < x.end)) continue;
    if (result.fields.some((x) => x.start === start)) continue;
    result.fields.push({
      name,
      start,
      end,
      owner: owner.name,
      type: cleanType(m[3] || ''),
      modifiers: (m[2] || '').trim().split(/\s+/).filter(Boolean),
      annotations: [...(m[1] || '').matchAll(/@([\w.]+)/g)].map((x) => x[1]),
      declaration: content.slice(start, end).trim()
    });
  }

  // Type-level annotations (look backwards from the declaration start)
  for (const t of result.types) {
    const before = code.slice(Math.max(0, t.start - 300), t.start);
    const trailing = before.match(/((?:@[\w.]+(?:\([^)]*\))?\s*)+)$/);
    if (trailing) {
      result.annotations.push({
        target: t.name,
        annotations: [...trailing[1].matchAll(/@([\w.]+)/g)].map((x) => x[1])
      });
    }
  }

  result.blocks = extractBlocks(content);
  return result;
}

/**
 * Whether a position lies inside a string, char, or comment.
 * @param {string} content
 * @param {number} pos
 * @returns {boolean}
 */
export function inStringOrComment(content, pos) {
  let inString = false, inChar = false, inComment = false, inLineComment = false, escape = false;
  for (let i = 0; i < pos && i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inComment) { if (ch === '*' && content[i + 1] === '/') { inComment = false; i++; } continue; }
    if (ch === '/' && content[i + 1] === '/') { inLineComment = true; continue; }
    if (ch === '/' && content[i + 1] === '*') { inComment = true; i++; continue; }
    if (ch === '"' && !inChar) { inString = !inString; continue; }
    if (ch === "'" && !inString) { inChar = !inChar; continue; }
  }
  return inString || inChar || inComment || inLineComment;
}

/**
 * Find all word-boundary occurrences of an identifier outside comments/strings.
 * @param {string} content
 * @param {string} identifier
 * @returns {Array<{start:number,end:number}>}
 */
export function findIdentifier(content, identifier) {
  const code = maskNonCode(content);
  const re = new RegExp(`\\b${identifier}\\b`, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(code)) !== null) hits.push({ start: m.index, end: m.index + m[0].length });
  return hits;
}

/**
 * Convert a character offset into a 1-based line/column pair.
 * @param {string} content
 * @param {number} pos
 * @returns {{line:number, col:number}}
 */
export function getLineCol(content, pos) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < content.length; i++) {
    if (content[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

/**
 * Slice helper kept for API compatibility.
 * @param {string} content
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function getRange(content, start, end) {
  return content.slice(start, end);
}
