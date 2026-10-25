/**
 * Fix rules for Java auto-correction.
 * Each rule: { name, description, level, apply(content, parsed, options) -> { edits, description, requiresJavac } }
 * Level: 'safe' (unique deterministic), 'all' (includes opinionated), 'unsafe' (requires review)
 */

import { parseJavaSource, findIdentifier, inStringOrComment } from '../java-source.js';
import { checkJavaSource, compilesClean, findMissingSymbols } from '../javac.js';
import { applyEdits, insert, remove, replace, hasImport, addImport, parseImports, removeUnusedImports, normalizeEol, restoreEol, ensureFinalNewline, tabsToSpaces } from '../edit.js';

/**
 * Known simple name -> fully qualified name. Only names that are unambiguous
 * and extremely common are listed, so an added import is always the right one.
 */
const COMMON_IMPORTS = {
  List: 'java.util.List',
  Map: 'java.util.Map',
  Set: 'java.util.Set',
  Collection: 'java.util.Collection',
  ArrayList: 'java.util.ArrayList',
  LinkedList: 'java.util.LinkedList',
  HashMap: 'java.util.HashMap',
  LinkedHashMap: 'java.util.LinkedHashMap',
  HashSet: 'java.util.HashSet',
  LinkedHashSet: 'java.util.LinkedHashSet',
  Optional: 'java.util.Optional',
  Stream: 'java.util.stream.Stream',
  Collectors: 'java.util.stream.Collectors',
  Objects: 'java.util.Objects',
  Arrays: 'java.util.Arrays',
  Collections: 'java.util.Collections',
  Comparator: 'java.util.Comparator',
  Serializable: 'java.io.Serializable',
  IOException: 'java.io.IOException',
  File: 'java.io.File',
  Path: 'java.nio.file.Path',
  Files: 'java.nio.file.Files',
  LocalDate: 'java.time.LocalDate',
  LocalDateTime: 'java.time.LocalDateTime',
  Duration: 'java.time.Duration',
  Instant: 'java.time.Instant',
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
  AtomicInteger: 'java.util.concurrent.atomic.AtomicInteger',
  ConcurrentHashMap: 'java.util.concurrent.ConcurrentHashMap',
  ExecutorService: 'java.util.concurrent.ExecutorService',
  Executors: 'java.util.concurrent.Executors',
  CompletableFuture: 'java.util.concurrent.CompletableFuture',
  TimeUnit: 'java.util.concurrent.TimeUnit',
  Logger: 'org.slf4j.Logger',
  LoggerFactory: 'org.slf4j.LoggerFactory',
  Autowired: 'org.springframework.beans.factory.annotation.Autowired',
  Component: 'org.springframework.stereotype.Component',
  Service: 'org.springframework.stereotype.Service',
  Repository: 'org.springframework.stereotype.Repository',
  RestController: 'org.springframework.web.bind.annotation.RestController',
  RequestMapping: 'org.springframework.web.bind.annotation.RequestMapping',
  GetMapping: 'org.springframework.web.bind.annotation.GetMapping',
  PostMapping: 'org.springframework.web.bind.annotation.PostMapping',
  RequestBody: 'org.springframework.web.bind.annotation.RequestBody',
  PathVariable: 'org.springframework.web.bind.annotation.PathVariable',
  RequestParam: 'org.springframework.web.bind.annotation.RequestParam',
  Entity: 'jakarta.persistence.Entity',
  Table: 'jakarta.persistence.Table',
  Id: 'jakarta.persistence.Id',
  GeneratedValue: 'jakarta.persistence.GeneratedValue',
  Column: 'jakarta.persistence.Column',
  ManyToOne: 'jakarta.persistence.ManyToOne',
  OneToMany: 'jakarta.persistence.OneToMany',
  JoinColumn: 'jakarta.persistence.JoinColumn',
  Test: 'org.junit.jupiter.api.Test',
  BeforeEach: 'org.junit.jupiter.api.BeforeEach',
  AfterEach: 'org.junit.jupiter.api.AfterEach',
  Mock: 'org.mockito.Mock',
  InjectMocks: 'org.mockito.InjectMocks'
};

/**
 * Rule: Remove unused imports
 * Level: safe
 */
export async function ruleRemoveUnusedImports(content, parsed, options) {
  const { content: newContent, removed, edits } = removeUnusedImports(content, parsed);
  return {
    applied: removed.length > 0,
    edits,
    description: `Remove ${removed.length} unused import(s): ${removed.join(', ')}`,
    requiresJavac: false
  };
}

/**
 * Rule: Add missing imports (requires javac to find missing symbols)
 * Level: safe (only if exactly one candidate and compiles)
 */
export async function ruleAddMissingImports(content, parsed, options) {
  const { toolRoots = [] } = options;
  const check = await checkJavaSource(content, { toolRoots });
  if (check.error) return { applied: false, edits: [], description: 'javac unavailable', requiresJavac: false };
  const missing = findMissingSymbols(check.diagnostics);
  if (!missing.length) return { applied: false, edits: [], description: 'No missing imports' };

  const added = [];
  let working = content;
  for (const symbol of missing) {
    const fqn = COMMON_IMPORTS[symbol];
    if (!fqn) continue;
    if (hasImport(working, fqn)) continue;
    const candidate = addImport(working, fqn, parseJavaSource(working));
    if (!candidate.added) continue;
    // Accept only when the diagnostic count actually drops (unique + effective).
    const after = await checkJavaSource(candidate.content, { toolRoots });
    if (after.errors < check.errors) {
      working = candidate.content;
      added.push(fqn);
    }
  }

  if (!added.length) {
    return { applied: false, edits: [], description: 'No import fix reduced compiler errors', requiresJavac: false };
  }
  return {
    applied: true,
    edits: [],
    content: working,
    description: `Add missing imports: ${added.join(', ')}`,
    requiresJavac: true
  };
}

/**
 * Rule: Add missing @Override annotations — only for fixes that are certain:
 * well-known Object overrides and methods of explicitly implemented interfaces.
 * Level: safe
 */
export function ruleAddOverride(content, parsed, options) {
  const edits = [];
  const added = [];

  const OBJECT_OVERRIDES = new Map([
    ['toString', 0],
    ['hashCode', 0],
    ['equals', 1],
    ['clone', 0],
    ['finalize', 0]
  ]);
  const INTERFACE_METHODS = new Map([
    ['Runnable', new Set(['run'])],
    ['Callable', new Set(['call'])],
    ['AutoCloseable', new Set(['close'])],
    ['Closeable', new Set(['close'])],
    ['Comparable', new Set(['compareTo'])],
    ['Iterable', new Set(['iterator'])],
    ['Comparator', new Set(['compare'])],
    ['CharSequence', new Set(['length', 'charAt', 'toString', 'subSequence'])]
  ]);

  for (const method of parsed.methods) {
    if (method.annotations.includes('Override')) continue;
    // Defensive: an annotation line right above the method is authoritative even
    // when the lightweight parser cannot attach it.
    if (/@Override\s*$/.test(content.slice(Math.max(0, method.start - 200), method.start))) continue;
    if (method.modifiers.includes('private') || method.modifiers.includes('static')) continue;
    if (method.isConstructor) continue;
    const owner = parsed.types.find((t) => t.keyword === 'class' && method.start > t.bodyStart && method.end < t.bodyEnd);
    if (!owner) continue;

    const arity = method.params.length;
    let certain = false;

    if (OBJECT_OVERRIDES.has(method.name) && OBJECT_OVERRIDES.get(method.name) === arity) {
      certain = true;
    } else {
      const header = content.slice(owner.start, owner.braceStart);
      const implMatch = header.match(/implements\s+([^{]+)/);
      if (implMatch) {
        const implemented = implMatch[1].split(',').map((s) => s.trim().split('<')[0].split('.').pop());
        for (const iface of implemented) {
          const methods = INTERFACE_METHODS.get(iface);
          if (methods && methods.has(method.name)) {
            certain = true;
            break;
          }
        }
      }
    }
    if (!certain) continue;

    const lineStart = content.lastIndexOf('\n', method.start - 1) + 1;
    const indent = content.slice(lineStart, method.start).match(/^[ \t]*/)[0];
    edits.push(insert(lineStart, indent + '@Override\n', `Add @Override to ${method.name}`));
    added.push(method.name);
  }

  return {
    applied: added.length > 0,
    edits,
    description: `Add @Override to ${added.length} method(s): ${added.join(', ')}`,
    requiresJavac: true
  };
}

/**
 * Rule: Remove redundant @Override (on interface default methods or when not actually overriding)
 * Level: safe
 */
export function ruleRemoveRedundantOverride(content, parsed, options) {
  const edits = [];
  const removed = [];

  for (const method of parsed.methods) {
    if (!method.annotations.includes('Override')) continue;
    // Check if it's actually overriding something
    // In interfaces, default methods can have @Override but it's optional
    const inInterface = parsed.types.some(t =>
      t.keyword === 'interface' && method.start > t.bodyStart && method.end < t.bodyEnd
    );
    if (inInterface && method.modifiers.includes('default')) {
      // Find @Override annotation position
      const beforeMethod = content.slice(Math.max(0, method.start - 100), method.start);
      const ovMatch = beforeMethod.match(/@Override\s*/);
      if (ovMatch) {
        const start = method.start - ovMatch[0].length;
        const end = method.start;
        edits.push(remove(start, end, `Remove redundant @Override from ${method.name}`));
        removed.push(method.name);
      }
    }
  }

  return {
    applied: removed.length > 0,
    edits,
    description: `Remove redundant @Override from ${removed.length} method(s): ${removed.join(', ')}`,
    requiresJavac: false
  };
}

/**
 * Rule: Add serialVersionUID to Serializable classes
 * Level: safe (deterministic computation)
 */
export function ruleAddSerialVersionUID(content, parsed, options) {
  const edits = [];
  const added = [];

  for (const type of parsed.types) {
    if (type.keyword !== 'class') continue;
    // Check if implements Serializable
    const typeDecl = content.slice(type.start, type.braceStart);
    if (!typeDecl.includes('Serializable')) continue;
    // Check if already has serialVersionUID
    const body = content.slice(type.bodyStart, type.bodyEnd);
    if (body.includes('serialVersionUID')) continue;

    // Compute serialVersionUID (simplified: hash of class structure)
    // Real algorithm uses SHA of class signature, but we use a stable hash
    const uid = computeSerialVersionUID(type, parsed, content);
    const fieldDecl = `\n    private static final long serialVersionUID = ${uid}L;`;
    // Insert after class opening brace
    const pos = type.bodyStart;
    edits.push(insert(pos, fieldDecl, `Add serialVersionUID to ${type.name}`));
    added.push(type.name);
  }

  return {
    applied: added.length > 0,
    edits,
    description: `Add serialVersionUID to ${added.length} class(es): ${added.join(', ')}`,
    requiresJavac: false
  };
}

function computeSerialVersionUID(type, parsed, content) {
  // Simplified deterministic hash based on class name and members
  let hash = 0;
  const str = type.name + parsed.methods.filter(m =>
    m.start > type.bodyStart && m.end < type.bodyEnd
  ).map(m => m.name + m.signature).join('') +
  parsed.fields.filter(f =>
    f.start > type.bodyStart && f.end < type.bodyEnd
  ).map(f => f.name + f.declaration).join('');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; // 32-bit
  }
  return Math.abs(hash);
}

/**
 * Rule: Organize imports (group + sort, never drops static/wildcard imports)
 * Level: safe
 */
export function ruleOrganizeImports(content, parsed, options) {
  const imports = parseImports(content);
  if (imports.length <= 1) return { applied: false, edits: [], description: 'Imports already organized' };

  const groups = { java: [], jakarta: [], javax: [], org: [], com: [], other: [], static: [] };
  for (const imp of imports) {
    const line = `import ${imp.isStatic ? 'static ' : ''}${imp.path};`;
    if (imp.isStatic) groups.static.push(line);
    else if (imp.path.startsWith('java.')) groups.java.push(line);
    else if (imp.path.startsWith('jakarta.')) groups.jakarta.push(line);
    else if (imp.path.startsWith('javax.')) groups.javax.push(line);
    else if (imp.path.startsWith('org.')) groups.org.push(line);
    else if (imp.path.startsWith('com.')) groups.com.push(line);
    else groups.other.push(line);
  }
  for (const group of Object.values(groups)) group.sort((a, b) => a.localeCompare(b));

  const order = ['java', 'jakarta', 'javax', 'org', 'com', 'other', 'static'];
  const lines = [];
  for (const name of order) {
    if (!groups[name].length) continue;
    if (lines.length) lines.push('');
    lines.push(...groups[name]);
  }

  const start = imports[0].start;
  const end = imports[imports.length - 1].end;
  const newText = lines.join('\n') + '\n\n';
  const current = content.slice(start, end);
  const already = current === newText;

  return {
    applied: !already,
    edits: already ? [] : [replace(start, end, newText, 'Organize imports')],
    description: already ? 'Imports already organized' : 'Organize imports (grouped and sorted)',
    requiresJavac: false
  };
}

/**
 * Rule: Normalize line endings and final newline
 * Level: safe
 */
export function ruleNormalizeWhitespace(content, parsed, options) {
  const { originalEol } = normalizeEol(content);
  let newContent = content.replace(/\r\n/g, '\n');
  newContent = ensureFinalNewline(newContent, '\n');
  // A blank line between the package statement and the next content (IDEA style).
  newContent = newContent.replace(/^(package[^\n]*;)\n(?=\S)/m, '$1\n\n');
  // A blank line between the import block and the type declaration.
  newContent = newContent.replace(/^((?:import[^\n]*;\n)+)/m, (block) => (block.endsWith('\n\n') ? block : block + '\n'));
  // Collapse runs of blank lines to one.
  newContent = newContent.replace(/\n{3,}/g, '\n\n');
  // Optionally convert tabs
  if (options.tabsToSpaces) newContent = tabsToSpaces(newContent);
  // Restore original EOL
  newContent = restoreEol(newContent, originalEol);

  if (newContent === content) return { applied: false, edits: [], description: 'Whitespace already normalized' };

  return {
    applied: true,
    edits: [replace(0, content.length, newContent, 'Normalize whitespace')],
    description: 'Normalize whitespace (EOL, final newline, package/import separation)',
    requiresJavac: false
  };
}

/**
 * Rule: Remove duplicate imports (static and wildcard forms included)
 * Level: safe
 */
export function ruleRemoveDuplicateImports(content, parsed, options) {
  const seen = new Set();
  const edits = [];
  const removed = [];
  for (const imp of parseImports(content)) {
    const key = (imp.isStatic ? 'static:' : '') + imp.path;
    if (seen.has(key)) {
      edits.push(remove(imp.start, imp.end, `Remove duplicate import ${imp.path}`));
      removed.push(imp.path);
    } else {
      seen.add(key);
    }
  }

  return {
    applied: removed.length > 0,
    edits,
    description: `Remove ${removed.length} duplicate import(s): ${removed.join(', ')}`,
    requiresJavac: false
  };
}

/**
 * All safe rules (default auto-fix set)
 */
export const SAFE_RULES = [
  { name: 'removeDuplicateImports', fn: ruleRemoveDuplicateImports, level: 'safe' },
  { name: 'removeUnusedImports', fn: ruleRemoveUnusedImports, level: 'safe' },
  { name: 'addMissingImports', fn: ruleAddMissingImports, level: 'safe' },
  { name: 'addOverride', fn: ruleAddOverride, level: 'safe' },
  { name: 'removeRedundantOverride', fn: ruleRemoveRedundantOverride, level: 'safe' },
  { name: 'addSerialVersionUID', fn: ruleAddSerialVersionUID, level: 'safe' },
  { name: 'organizeImports', fn: ruleOrganizeImports, level: 'safe' },
  { name: 'normalizeWhitespace', fn: ruleNormalizeWhitespace, level: 'safe' }
];

/**
 * All rules (including opinionated)
 */
export const ALL_RULES = [
  ...SAFE_RULES
  // Add more rules here for 'all' level
];
