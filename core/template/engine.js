/**
 * Template engine for Java code generation.
 * Intent + parameters in, deterministic Java source out.
 *
 * Public API:
 *   applyTemplate(content, ops, context?) -> { content, applied, imports, description }
 *   registerTemplate(name, fn), getTemplate(name), listTemplates()
 */

import { parseJavaSource } from '../java-source.js';
import { applyEdits, insert, hasImport, addImport } from '../edit.js';
import { resolvePreset, listPresets } from './presets.js';

const templates = new Map();
const INDENT = '    ';

/**
 * Register a template operation.
 * @param {string} name
 * @param {(params:any, content:string, parsed:object) => {content:string, description:string, imports?:string[]}} fn
 */
export function registerTemplate(name, fn) {
  templates.set(name, fn);
}

/** @param {string} name */
export function getTemplate(name) {
  return templates.get(name);
}

/** @returns {string[]} */
export function listTemplates() {
  return [...templates.keys()];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Normalize a field spec: [type, name] / "type name" / {type,name,...}. */
function normalizeField(f) {
  if (Array.isArray(f)) return { type: String(f[0]), name: String(f[1]) };
  if (typeof f === 'string') {
    const idx = f.trim().lastIndexOf(' ');
    if (idx < 0) return { type: 'Object', name: f.trim() };
    return { type: f.slice(0, idx).trim(), name: f.slice(idx + 1).trim() };
  }
  return { ...f, type: String(f.type || 'Object'), name: String(f.name) };
}

/** Normalize an annotation spec: string or {name, value}. */
function annotate(ann) {
  if (typeof ann === 'string') return '@' + ann;
  const value = ann.value !== undefined ? `("${ann.value}")` : '';
  return '@' + ann.name + value;
}

/** Indent every line of a member block by one level. */
function indentBlock(text) {
  return text.split('\n').map((line) => (line.trim() ? INDENT + line : line)).join('\n');
}

/**
 * Insert member text immediately before the type's closing brace,
 * separated from existing members by a blank line.
 * @param {string} content
 * @param {object} type
 * @param {string} text
 * @returns {string}
 */
function insertInBody(content, type, text) {
  const close = type.bodyEnd; // index of '}'
  const lineStart = content.lastIndexOf('\n', close - 1) + 1;
  const prefix = content.slice(lineStart, close);
  const pos = prefix.trim() === '' ? lineStart : close;
  const before = content.slice(type.bodyStart, pos).trimEnd();
  const gap = content.slice(type.bodyStart, pos);
  const prev = pos > 0 ? content[pos - 1] : '\n';
  const lead = before === '' ? (gap.includes('\n') ? '' : '\n') : prev === '\n' ? '\n' : '\n\n';
  const block = lead + indentBlock(text.trimEnd()) + '\n';
  return applyEdits(content, [insert(pos, block)]);
}

/**
 * Insert member text at the beginning of the type body.
 */
function insertAtBodyStart(content, type, text) {
  const pos = type.bodyStart;
  const after = content[pos] || '\n';
  const trail = after === '\n' ? '' : '\n';
  const block = '\n' + indentBlock(text.trimEnd()) + trail;
  return applyEdits(content, [insert(pos, block)]);
}

/** True when a type is not nested inside another type. */
function isTopLevel(type, parsed) {
  return !parsed.types.some((t) => t !== type && type.start > t.bodyStart && type.end < t.bodyEnd);
}

/** Choose the primary type to edit. */
function primaryType(parsed, kinds = ['class', 'record', 'interface', 'enum']) {
  const pool = parsed.types.filter((t) => isTopLevel(t, parsed));
  const candidates = pool.length ? pool : parsed.types;
  for (const kind of kinds) {
    const found = candidates.find((t) => t.keyword === kind);
    if (found) return found;
  }
  return candidates[0];
}

/** Fields of a type (record components count as fields). */
function fieldsOf(parsed, type) {
  const declared = parsed.fields.filter((f) => !type || f.owner === type.name);
  if (type && type.components && type.components.length) {
    const have = new Set(declared.map((f) => f.name));
    for (const c of type.components) if (!have.has(c.name)) declared.push({ ...c, modifiers: [], annotations: [] });
  }
  return declared;
}

/** Render a field declaration. */
function renderField(field) {
  const f = normalizeField(field);
  const lines = [];
  for (const ann of f.annotations || []) lines.push(annotate(ann));
  const mods = f.modifiers && f.modifiers.length ? f.modifiers.join(' ') + ' ' : '';
  let decl = `${mods}${f.type} ${f.name}`;
  if (f.value !== undefined) decl += ` = ${f.value}`;
  return lines.concat(decl + ';').join('\n');
}

/** Render a method declaration. */
function renderMethod(method) {
  const m = method;
  const lines = [];
  for (const ann of m.annotations || []) lines.push(annotate(ann));
  const mods = m.modifiers === undefined ? 'public ' : (m.modifiers.length ? m.modifiers.join(' ') + ' ' : '');
  const params = (m.params || []).map((p) => (Array.isArray(p) ? `${p[0]} ${p[1]}` : `${p.type} ${p.name}`)).join(', ');
  const throwsText = m.throws && m.throws.length ? ` throws ${m.throws.join(', ')}` : '';
  lines.push(`${mods}${m.returnType || 'void'} ${m.name}(${params})${throwsText} {`);
  const body = (m.body || '').trim();
  if (body) for (const line of body.split('\n')) lines.push(INDENT + line);
  lines.push('}');
  return lines.join('\n');
}

/** Render a constructor. */
function renderConstructor(typeName, ctor) {
  const mods = ctor.modifiers && ctor.modifiers.length ? ctor.modifiers.join(' ') + ' ' : '';
  const params = (ctor.params || []).map((p) => (Array.isArray(p) ? `${p[0]} ${p[1]}` : `${p.type} ${p.name}`)).join(', ');
  const lines = [`${mods}${typeName}(${params}) {`];
  if (ctor.body) for (const line of String(ctor.body).trim().split('\n')) lines.push(INDENT + line);
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// type generation
// ---------------------------------------------------------------------------

/** Render a Javadoc block (no indentation applied here). */
function renderJavadoc(doc) {
  if (!doc) return [];
  const lines = [];
  if (typeof doc === 'string') {
    for (const line of doc.split('\n')) lines.push(' ' + line.trim());
  } else {
    if (doc.text) for (const line of String(doc.text).split('\n')) lines.push(' ' + line.trim());
    for (const p of doc.params || []) lines.push(` @param ${p.name || p[0]} ${p.desc || p[1] || ''}`.trimEnd());
    if (doc.returns) lines.push(` @return ${doc.returns}`);
    if (doc.throws) lines.push(` @throws ${doc.throws}`);
  }
  return ['/**', ...lines, ' */'];
}

function renderTypeHeader(kind, spec, name) {
  const lines = [...renderJavadoc(spec.javadoc)];
  for (const ann of spec.annotations || []) lines.push(annotate(ann));
  const modifiers = spec.modifiers && spec.modifiers.length ? spec.modifiers.join(' ') + ' ' : '';
  const typeParams = spec.typeParams && spec.typeParams.length ? `<${spec.typeParams.join(', ')}>` : '';
  return { lines, modifiers, typeParams };
}

function generateType(kind, spec, content, parsed) {
  const imports = new Set();
  const name = spec.name;
  const header = renderTypeHeader(kind, spec, name);
  const declLines = [...header.lines];
  const ext = spec.extends
    ? ` extends ${Array.isArray(spec.extends) ? spec.extends.join(', ') : spec.extends}`
    : '';
  const impl = spec.implements && spec.implements.length ? ` implements ${spec.implements.join(', ')}` : '';
  const permits = spec.permits && spec.permits.length ? ` permits ${spec.permits.join(', ')}` : '';
  const memberBlocks = [];

  if (kind === 'record') {
    const comps = (spec.fields || []).map(normalizeField);
    const headerFields = comps.map((f) => `${f.type} ${f.name}`).join(', ');
    if (spec.methods && spec.methods.length) memberBlocks.push(spec.methods.map(renderMethod).join('\n\n'));
    if (spec.body) memberBlocks.push(String(spec.body).trim());
    const bodyText = memberBlocks.length ? '\n' + indentBlock(memberBlocks.join('\n\n')) + '\n' : '';
    declLines.push(`${header.modifiers}record ${name}${header.typeParams}(${headerFields})${impl}${permits} {${bodyText}}`);
    return { declaration: declLines.join('\n'), imports, description: `Create record ${name}` };
  }

  if (kind === 'enum') {
    const constants = (spec.constants || []).join(', ');
    if (spec.fields && spec.fields.length) memberBlocks.push(spec.fields.map(renderField).join('\n'));
    if (spec.methods && spec.methods.length) memberBlocks.push(spec.methods.map(renderMethod).join('\n\n'));
    const bodyParts = [];
    if (constants) bodyParts.push(constants + (memberBlocks.length ? ';' : ''));
    bodyParts.push(...memberBlocks);
    const bodyText = bodyParts.length ? '\n' + indentBlock(bodyParts.join('\n\n')) + '\n' : '';
    declLines.push(`${header.modifiers}enum ${name}${impl}${permits} {${bodyText}}`);
    return { declaration: declLines.join('\n'), imports, description: `Create enum ${name}` };
  }

  if (kind === 'annotation') {
    const members = (spec.members || spec.fields || []).map(normalizeField);
    const lines = members.map((m) => {
      const anns = (m.annotations || []).map((a) => annotate(a) + '\n');
      const def = m.default !== undefined ? ` default ${m.default}` : '';
      return anns.join('') + `${m.type || 'String'} ${m.name}()${def};`;
    });
    const bodyText = lines.length ? '\n' + indentBlock(lines.join('\n')) + '\n' : '';
    declLines.push(`${header.modifiers}@interface ${name} {${bodyText}}`);
    return { declaration: declLines.join('\n'), imports, description: `Create annotation ${name}` };
  }

  // class / interface
  const fields = (spec.fields || []).map(renderField);
  const ctors = (spec.constructors || []).map((c) => renderConstructor(name, c));
  const methods = (spec.methods || []).map((m) => {
    if (kind === 'interface' && !m.body && !(m.modifiers || []).includes('default') && !(m.modifiers || []).includes('static')) {
      return `${m.modifiers && m.modifiers.length ? m.modifiers.join(' ') + ' ' : ''}${m.returnType || 'void'} ${m.name}(${(m.params || [])
        .map((p) => (Array.isArray(p) ? `${p[0]} ${p[1]}` : `${p.type} ${p.name}`))
        .join(', ')});`;
    }
    return renderMethod(m);
  });
  if (spec.body) fields.push(String(spec.body).trim());

  const blocks = [];
  if (fields.length) blocks.push(fields.join('\n'));
  if (ctors.length) blocks.push(ctors.join('\n\n'));
  if (methods.length) blocks.push(methods.join('\n\n'));

  const bodyText = blocks.length ? '\n' + indentBlock(blocks.join('\n\n')) + '\n' : '';
  declLines.push(`${header.modifiers}${kind} ${name}${header.typeParams}${ext}${impl}${permits} {${bodyText}}`);
  return { declaration: declLines.join('\n'), imports, description: `Create ${kind} ${name}` };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Parse a string type spec into an object (token-saving shorthand).
 * Examples: "User", "public User", "User(long id, String name)", "Color: RED,GREEN".
 */
function parseTypeSpec(kind, raw) {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (kind === 'record') {
    const m = text.match(/^([\w$.]+)\s*(?:\(([^)]*)\))?$/);
    if (!m) throw new Error(`invalid record spec: ${raw}`);
    const fields = m[2]
      ? m[2].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
          const i = s.lastIndexOf(' ');
          return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : ['Object', s];
        })
      : [];
    return { name: m[1], fields };
  }
  if (kind === 'enum') {
    const m = text.match(/^([\w$.]+)\s*(?:[:{](.*?)[}]?)?$/);
    if (!m) throw new Error(`invalid enum spec: ${raw}`);
    const constants = m[2] ? m[2].split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return { name: m[1], ...(constants ? { constants } : {}) };
  }
  const MODIFIERS = new Set(['public', 'protected', 'private', 'final', 'abstract', 'sealed', 'static']);
  const mods = [];
  let name;
  for (const token of text.split(/\s+/)) {
    if (MODIFIERS.has(token)) mods.push(token);
    else name = token;
  }
  if (!name) throw new Error(`invalid ${kind} spec: ${raw}`);
  return { name, ...(mods.length ? { modifiers: mods } : {}) };
}

/**
 * Expand `intent`/`preset` into concrete ops, merging top-level shortcut params.
 * @param {object} ops
 * @returns {{ops:object, imports:string[]}}
 */
export function expandIntent(ops = {}) {
  const base = { ...ops };
  const intent = base.intent !== undefined ? base.intent : base.preset;
  delete base.intent;
  delete base.preset;
  if (intent === undefined || intent === null || intent === false) return { ops: base, imports: [] };

  let presetName;
  const params = {};
  if (typeof intent === 'string') {
    presetName = intent;
  } else if (typeof intent === 'object' && (intent.preset || intent.intent)) {
    presetName = intent.preset || intent.intent;
    for (const [k, v] of Object.entries(intent)) {
      if (k !== 'preset' && k !== 'intent') params[k] = v;
    }
  } else {
    throw new Error('intent must be a preset name or an object with a "preset" field');
  }

  const SHORTCUTS = [
    'name', 'fields', 'methods', 'constants', 'dependencies', 'permits', 'members', 'routes',
    'basePath', 'entity', 'idType', 'layout', 'table', 'target', 'beanType', 'beanName',
    'builder', 'logger', 'implements', 'extends', 'typeParams', 'annotations', 'body',
    'modifiers', 'compactConstructor'
  ];
  for (const key of SHORTCUTS) {
    if (base[key] !== undefined) {
      params[key] = base[key];
      delete base[key];
    }
  }

  const resolved = resolvePreset(presetName, params);
  return { ops: { ...resolved.ops, ...base }, imports: resolved.imports || [] };
}

/**
 * Apply template operations to Java source.
 * @param {string} content
 * @param {object} ops
 * @param {object} [context]
 * @returns {{content:string, applied:Array, imports:string[], description:string}}
 */
export function applyTemplate(content, ops = {}, context = {}) {
  let working = content;
  let parsed = context.parsed || parseJavaSource(working);
  const applied = [];
  const expanded = expandIntent(ops);
  ops = expanded.ops;
  const allImports = new Set(expanded.imports);

  // 1) Type creation (string specs and string fields are accepted as shorthand)
  for (const kind of ['class', 'interface', 'record', 'enum', 'annotation']) {
    if (!ops[kind]) continue;
    const spec = parseTypeSpec(kind, ops[kind]);
    if (Array.isArray(spec.fields)) spec.fields = spec.fields.map(normalizeField);
    if (Array.isArray(spec.members)) spec.members = spec.members.map(normalizeField);
    const generated = generateType(kind, spec, working, parsed);
    if (working.trim()) {
      working = working.replace(/\n*$/, '') + '\n\n' + generated.declaration + '\n';
    } else {
      working = generated.declaration + '\n';
    }
    for (const imp of generated.imports) allImports.add(imp);
    applied.push({ op: kind, description: generated.description });
    parsed = parseJavaSource(working);
  }

  // 2) Member operations
  const memberOps = [
    'fields', 'constructors', 'getters', 'setters', 'methods', 'builder', 'singleton',
    'compactConstructor', 'equalsHashCode', 'toString', 'logger', 'main', 'javadoc',
    'annotations', 'imports'
  ];
  for (const op of memberOps) {
    if (!Object.prototype.hasOwnProperty.call(ops, op)) continue;
    if (!ops[op]) continue;
    const fn = templates.get(op);
    if (!fn) continue;
    parsed = parseJavaSource(working);
    const result = fn(ops[op], working, parsed);
    if (result && result.content !== undefined) working = result.content;
    for (const imp of result.imports || []) allImports.add(imp);
    applied.push({ op, description: result.description || op });
  }

  // 3) Imports
  for (const imp of allImports) {
    if (hasImport(working, imp)) continue;
    const res = addImport(working, imp, parseJavaSource(working));
    if (res.added) working = res.content;
  }
  // Keep the import block visually separate from the type declaration.
  working = working.replace(/^((?:import[^\n]*;\n)+)/m, (block) => (block.endsWith('\n\n') ? block : block + '\n'));

  return {
    content: working,
    applied,
    imports: [...allImports],
    description: applied.map((a) => a.description).join('; ')
  };
}

// ---------------------------------------------------------------------------
// member templates
// ---------------------------------------------------------------------------

registerTemplate('fields', (params, content, parsed) => {
  const type = primaryType(parsed);
  if (!type) return { content, description: 'No type to add fields to', imports: [] };
  const fields = (Array.isArray(params) ? params : [params]).map(normalizeField);
  const text = fields.map(renderField).join('\n');
  return {
    content: insertAtBodyStart(content, type, text),
    description: `Add ${fields.length} field(s)`,
    imports: []
  };
});

registerTemplate('methods', (params, content, parsed) => {
  const type = primaryType(parsed, ['class', 'enum', 'interface']);
  if (!type) return { content, description: 'No type to add methods to', imports: [] };
  const methods = Array.isArray(params) ? params : [params];
  const text = methods.map(renderMethod).join('\n\n');
  return {
    content: insertInBody(content, type, text),
    description: `Add ${methods.length} method(s)`,
    imports: []
  };
});

registerTemplate('constructors', (params, content, parsed) => {
  const type = primaryType(parsed, ['class']);
  if (!type) return { content, description: 'No class to add constructors to', imports: [] };
  const ctors = Array.isArray(params) ? params : [params];
  const fields = fieldsOf(parsed, type);
  const text = ctors.map((ctor) => {
    let body = ctor.body;
    if (body === undefined) {
      const ctorParams = ctor.params || fields.map((f) => ({ type: f.type, name: f.name }));
      body = ctorParams.map((p) => {
        const name = Array.isArray(p) ? p[1] : p.name;
        return `this.${name} = ${name};`;
      }).join('\n');
      return renderConstructor(type.name, { ...ctor, params: ctorParams, body });
    }
    return renderConstructor(type.name, ctor);
  }).join('\n\n');
  return {
    content: insertInBody(content, type, text),
    description: `Add ${ctors.length} constructor(s)`,
    imports: []
  };
});

registerTemplate('builder', (params, content, parsed) => {
  const type = primaryType(parsed, ['class', 'record']);
  if (!type) return { content, description: 'No class to add builder to', imports: [] };
  const fields = (params && params.fields ? params.fields : fieldsOf(parsed, type)).map(normalizeField);
  const className = (params && params.className) || type.name;
  const builderName = className + 'Builder';
  const isRecord = type.keyword === 'record';
  const buildExpr = isRecord
    ? `new ${className}(${fields.map((f) => f.name).join(', ')})`
    : `new ${className}(this)`;
  const lines = [];
  lines.push(`public static class ${builderName} {`);
  for (const f of fields) lines.push(INDENT + `private ${f.type} ${f.name};`);
  if (fields.length) lines.push('');
  for (const f of fields) {
    lines.push(INDENT + `public ${builderName} ${f.name}(${f.type} ${f.name}) {`);
    lines.push(INDENT + INDENT + `this.${f.name} = ${f.name};`);
    lines.push(INDENT + INDENT + 'return this;');
    lines.push(INDENT + '}');
    lines.push('');
  }
  lines.push(INDENT + `public ${className} build() {`);
  lines.push(INDENT + INDENT + `return ${buildExpr};`);
  lines.push(INDENT + '}');
  lines.push('}');
  const block = lines.join('\n');

  const ctor = isRecord ? '' : [
    `private ${className}(${builderName} builder) {`,
    ...fields.map((f) => INDENT + `this.${f.name} = builder.${f.name};`),
    '}'
  ].join('\n');

  const factory = [
    `public static ${builderName} builder() {`,
    INDENT + `return new ${builderName}();`,
    '}'
  ].join('\n');

  const text = ctor ? block + '\n\n' + ctor + '\n\n' + factory : block + '\n\n' + factory;
  return {
    content: insertInBody(content, type, text),
    description: `Add builder pattern for ${className}`,
    imports: []
  };
});

registerTemplate('equalsHashCode', (params, content, parsed) => {
  const type = primaryType(parsed);
  if (!type) return { content, description: 'No type for equals/hashCode', imports: [] };
  const allFields = fieldsOf(parsed, type);
  const requested = params && Array.isArray(params.fields) ? new Set(params.fields) : null;
  const fields = allFields
    .filter((f) => !requested || requested.has(f.name))
    .map((f) => ({ name: f.name, type: f.type || 'Object' }));
  if (!fields.length) return { content, description: 'No fields for equals/hashCode', imports: [] };
  const imports = new Set(['java.util.Objects']);
  const PRIMITIVES = /^(byte|short|int|long|float|double|boolean|char)$/;
  const lines = [];
  lines.push('@Override');
  lines.push('public boolean equals(Object obj) {');
  lines.push(INDENT + 'if (this == obj) return true;');
  lines.push(INDENT + 'if (obj == null || getClass() != obj.getClass()) return false;');
  lines.push(INDENT + `${type.name} that = (${type.name}) obj;`);
  for (const f of fields) {
    if (PRIMITIVES.test(f.type)) {
      lines.push(INDENT + `if (this.${f.name} != that.${f.name}) return false;`);
    } else if (f.type.endsWith('[]')) {
      imports.add('java.util.Arrays');
      lines.push(INDENT + `if (!Arrays.equals(this.${f.name}, that.${f.name})) return false;`);
    } else {
      lines.push(INDENT + `if (!Objects.equals(this.${f.name}, that.${f.name})) return false;`);
    }
  }
  lines.push(INDENT + 'return true;');
  lines.push('}');
  lines.push('');
  lines.push('@Override');
  lines.push('public int hashCode() {');
  lines.push(INDENT + `return Objects.hash(${fields.map((f) => f.name).join(', ')});`);
  lines.push('}');
  return {
    content: insertInBody(content, type, lines.join('\n')),
    description: `Add equals/hashCode for ${fields.length} field(s)`,
    imports: [...imports]
  };
});

registerTemplate('toString', (params, content, parsed) => {
  const type = primaryType(parsed);
  if (!type) return { content, description: 'No type for toString', imports: [] };
  const fields = (params && params.fields ? params.fields.map((f) => (typeof f === 'string' ? { name: f } : f)) : fieldsOf(parsed, type));
  const names = fields.map((f) => f.name).filter(Boolean);
  const lines = [];
  lines.push('@Override');
  lines.push('public String toString() {');
  if (!names.length) {
    lines.push(INDENT + `return "${type.name}()";`);
  } else {
    const parts = names.map((n, i) => `${i === 0 ? '' : '", " + '}"${n}=" + ${n}`).join(' + ');
    lines.push(INDENT + `return "${type.name}(" + ${parts} + ")";`);
  }
  lines.push('}');
  return {
    content: insertInBody(content, type, lines.join('\n')),
    description: `Add toString (${names.length} field(s))`,
    imports: []
  };
});

registerTemplate('logger', (params, content, parsed) => {
  const type = primaryType(parsed, ['class', 'enum']);
  if (!type) return { content, description: 'No type to add logger to', imports: [] };
  const framework = (params && params.framework) || 'slf4j';
  const fieldName = (params && params.fieldName) || 'log';
  const isStatic = !params || params.static !== false;
  const imports = [];
  let decl;
  if (framework === 'jul') {
    imports.push('java.util.logging.Logger');
    decl = `${isStatic ? 'private static final' : 'private final'} Logger ${fieldName} = Logger.getLogger(${type.name}.class.getName());`;
  } else if (framework === 'log4j2') {
    imports.push('org.apache.logging.log4j.LogManager', 'org.apache.logging.log4j.Logger');
    decl = `${isStatic ? 'private static final' : 'private final'} Logger ${fieldName} = LogManager.getLogger(${type.name}.class);`;
  } else {
    imports.push('org.slf4j.Logger', 'org.slf4j.LoggerFactory');
    decl = `${isStatic ? 'private static final' : 'private final'} Logger ${fieldName} = LoggerFactory.getLogger(${type.name}.class);`;
  }
  return {
    content: insertAtBodyStart(content, type, decl),
    description: `Add ${framework} logger (${fieldName})`,
    imports
  };
});

registerTemplate('main', (params, content, parsed) => {
  const type = primaryType(parsed, ['class']);
  if (!type) return { content, description: 'No class to add main to', imports: [] };
  const lines = ['public static void main(String[] args) {'];
  if (params && params.body) for (const line of String(params.body).trim().split('\n')) lines.push(INDENT + line);
  lines.push('}');
  return { content: insertInBody(content, type, lines.join('\n')), description: 'Add main method', imports: [] };
});

registerTemplate('annotations', (params, content, parsed) => {
  const list = Array.isArray(params) ? params : [params];
  const edits = [];
  for (const ann of list) {
    let target;
    if (ann.target === 'class' || !ann.target) target = parsed.types[0];
    else if (ann.target === 'field') target = parsed.fields.find((f) => f.name === ann.targetName);
    else if (ann.target === 'method') target = parsed.methods.find((m) => m.name === ann.targetName);
    if (!target) continue;
    const text = annotate({ name: ann.name, value: ann.value }) + '\n';
    const pos = target.start;
    edits.push(insert(pos, text));
  }
  return {
    content: edits.length ? applyEdits(content, edits) : content,
    description: `Add ${edits.length} annotation(s)`,
    imports: []
  };
});

registerTemplate('imports', (params, content, parsed) => {
  const list = Array.isArray(params) ? params : [params];
  let working = content;
  let added = 0;
  for (const imp of list) {
    const p = parseJavaSource(working);
    const res = addImport(working, String(imp), p);
    if (res.added) { working = res.content; added++; }
  }
  return {
    content: working,
    description: `Add ${added} import(s)`,
    imports: []
  };
});

// ---------------------------------------------------------------------------
// accessors / javadoc / patterns
// ---------------------------------------------------------------------------

/** Fields eligible for accessor generation (instance fields only). */
function instanceFields(parsed, type) {
  return fieldsOf(parsed, type).filter((f) => !(f.modifiers || []).includes('static'));
}

/** Method names already declared on the type. */
function existingMethodNames(parsed, type) {
  return new Set(parsed.methods.filter((m) => m.owner === type.name).map((m) => m.name));
}

function capitalize(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

function getterName(field) {
  const isBool = /^(boolean|Boolean)$/.test(field.type);
  return `${isBool ? 'is' : 'get'}${capitalize(field.name)}`;
}

registerTemplate('getters', (params, content, parsed) => {
  const type = primaryType(parsed);
  if (!type) return { content, description: 'No type to add getters to', imports: [] };
  const existing = existingMethodNames(parsed, type);
  const only = params && Array.isArray(params.fields) ? new Set(params.fields) : null;
  const fields = instanceFields(parsed, type).filter((f) => (!only || only.has(f.name)) && !existing.has(getterName(f)));
  if (!fields.length) return { content, description: 'No getters to add', imports: [] };
  const text = fields.map((f) => [
    `public ${f.type} ${getterName(f)}() {`,
    INDENT + `return ${f.name};`,
    '}'
  ].join('\n')).join('\n\n');
  return {
    content: insertInBody(content, type, text),
    description: `Add ${fields.length} getter(s)`,
    imports: []
  };
});

registerTemplate('setters', (params, content, parsed) => {
  const type = primaryType(parsed);
  if (!type) return { content, description: 'No type to add setters to', imports: [] };
  const existing = existingMethodNames(parsed, type);
  const only = params && Array.isArray(params.fields) ? new Set(params.fields) : null;
  const fields = instanceFields(parsed, type).filter((f) =>
    !(f.modifiers || []).includes('final') &&
    (!only || only.has(f.name)) &&
    !existing.has('set' + capitalize(f.name))
  );
  if (!fields.length) return { content, description: 'No setters to add', imports: [] };
  const text = fields.map((f) => [
    `public void set${capitalize(f.name)}(${f.type} ${f.name}) {`,
    INDENT + `this.${f.name} = ${f.name};`,
    '}'
  ].join('\n')).join('\n\n');
  return {
    content: insertInBody(content, type, text),
    description: `Add ${fields.length} setter(s)`,
    imports: []
  };
});

registerTemplate('javadoc', (params, content, parsed) => {
  const spec = params && typeof params === 'object' ? params : { text: String(params || '') };
  const targetKind = spec.target || 'class';
  let target;
  if (targetKind === 'class' || targetKind === 'type') {
    target = spec.name ? parsed.types.find((t) => t.name === spec.name) : primaryType(parsed);
  } else if (targetKind === 'field') {
    target = parsed.fields.find((f) => f.name === spec.name);
  } else if (targetKind === 'method') {
    target = parsed.methods.find((m) => m.name === spec.name);
  }
  if (!target) return { content, description: `No ${targetKind} to document`, imports: [] };

  const lineStart = content.lastIndexOf('\n', target.start - 1) + 1;
  const indent = content.slice(lineStart, target.start).match(/^[ \t]*/)[0];
  const before = content.slice(0, lineStart).trimEnd();
  if (before.endsWith('*/')) return { content, description: 'Javadoc already present', imports: [] };

  const doc = renderJavadoc(spec).map((line) => indent + line).join('\n') + '\n';
  return {
    content: applyEdits(content, [insert(lineStart, doc)]),
    description: `Add javadoc to ${targetKind}`,
    imports: []
  };
});

registerTemplate('singleton', (params, content, parsed) => {
  const type = primaryType(parsed, ['class']);
  if (!type) return { content, description: 'No class for singleton', imports: [] };
  if (new RegExp(`\\bgetInstance\\s*\\(`).test(content) && content.includes('INSTANCE')) {
    return { content, description: 'Singleton already present', imports: [] };
  }
  const fieldName = (params && params.fieldName) || 'INSTANCE';
  const text = [
    `private static final ${type.name} ${fieldName} = new ${type.name}();`,
    '',
    `private ${type.name}() {`,
    '}',
    '',
    `public static ${type.name} getInstance() {`,
    INDENT + `return ${fieldName};`,
    '}'
  ].join('\n');
  return {
    content: insertInBody(content, type, text),
    description: `Add singleton accessor (${fieldName})`,
    imports: []
  };
});

registerTemplate('compactConstructor', (params, content, parsed) => {
  const type = primaryType(parsed, ['record']);
  if (!type || type.keyword !== 'record') {
    return { content, description: 'No record for compact constructor', imports: [] };
  }
  const comps = (type.components || []).filter((c) => !/^(int|long|double|float|boolean|byte|short|char)$/.test(c.type));
  const explicit = params && Array.isArray(params.fields) ? params.fields : null;
  const chosen = explicit ? comps.filter((c) => explicit.includes(c.name)) : comps;
  if (!chosen.length) return { content, description: 'No components to validate', imports: [] };
  const lines = [`public ${type.name} {`];
  for (const c of chosen) {
    lines.push(INDENT + `if (${c.name} == null) throw new IllegalArgumentException("${c.name} must not be null");`);
  }
  lines.push('}');
  return {
    content: insertInBody(content, type, lines.join('\n')),
    description: `Add compact constructor validating ${chosen.length} component(s)`,
    imports: []
  };
});

export { listPresets };
