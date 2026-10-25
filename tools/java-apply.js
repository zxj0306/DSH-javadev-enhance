/**
 * java_apply tool: intent + parameter templates -> Java source.
 * Also java_apply_list to enumerate templates.
 */

import { applyTemplate, listTemplates, listPresets } from '../core/template/engine.js';
import { parseJavaSource } from '../core/java-source.js';
import { autoFix } from '../core/fix/engine.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { defineTool } from './define.js';

/**
 * Infer a package from common source roots in the path.
 * @param {string} filePath
 * @returns {string}
 */
function inferPackage(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const marker = normalized.match(/(?:^|\/)(?:src\/main\/java|src\/test\/java|src\/main\/kotlin|src\/test\/kotlin)\/(.+)\/[^/]+\.java$/);
  if (!marker) return '';
  return marker[1].split('/').filter(Boolean).join('.');
}

const OPS = {
  type: 'object',
  description: 'Template operations. One call may combine several.',
  properties: {
    intent: { description: 'Minimal intent: preset name (e.g. "pojo", "entity", "service", "test") or {name, ...params}.' },
    class: { description: 'Create a class — object or shorthand "public User"' },
    interface: { description: 'Create an interface — object or shorthand "public UserRepository"' },
    record: { description: 'Create a record — object or shorthand "User(long id, String name)"' },
    enum: { description: 'Create an enum — object or shorthand "Color: RED,GREEN"' },
    annotation: { description: 'Create an @interface — object or shorthand "MyAnnotation"' },
    fields: { type: 'array', description: 'Add fields; each item [type,name], "type name" or {type,name,...}' },
    methods: { type: 'array', description: 'Add methods' },
    constructors: { type: 'array', description: 'Add constructors' },
    getters: { description: 'Generate getters for fields (true or {fields:[names]})' },
    setters: { description: 'Generate setters for fields (true or {fields:[names]})' },
    builder: { type: 'object', description: 'Add fluent builder' },
    singleton: { type: 'object', description: 'Add eager singleton accessor' },
    compactConstructor: { type: 'object', description: 'Add record compact constructor with null checks' },
    equalsHashCode: { type: 'object', description: 'Add equals/hashCode' },
    toString: { type: 'object', description: 'Add toString' },
    logger: { type: 'object', description: 'Add logger field' },
    javadoc: { type: 'object', description: 'Add javadoc to class/field/method' },
    imports: { type: 'array', items: { type: 'string' }, description: 'Add imports' },
    annotations: { type: 'array', description: 'Add annotations' },
    main: { type: 'object', description: 'Add main method' }
  }
};

export const schema = {
  name: 'java_apply',
  description: 'Generate or extend Java code from minimal intents: one preset word (pojo/entity/service/controller/repository/test/singleton/exception/enum/interface/annotation/sealed/config/activity/util/constant/dto/immutable/record/recordBuilder/main/benchmark/ringbuf/objectpool/soa/mat4/gameloop/framebuffer/parallel/arena/lwjgl/noise) or granular ops. Saves tokens versus emitting full source.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target .java path relative to the session cwd; created if missing.' },
      package: { type: 'string', description: 'Package declaration for a new file; inferred from src/main/java or src/test/java when omitted.' },
      intent: { type: 'string', description: 'One-word preset, e.g. "pojo", "record", "entity", "service", "test".' },
      preset: { type: 'string', description: 'Alias of intent.' },
      name: { type: 'string', description: 'Type name shortcut used by intent.' },
      fields: { type: 'array', description: 'Field shortcut used by intent: [[type,name], ...] or ["Type name"]' },
      methods: { type: 'array', description: 'Method shortcut used by intent.' },
      constants: { type: 'array', description: 'Enum constants / constant fields shortcut.' },
      dependencies: { type: 'array', description: 'Constructor dependencies shortcut: [[type,name], ...]' },
      params: { type: 'object', description: 'Additional preset parameters.' },
      ops: OPS,
      dryRun: { type: 'boolean', description: 'Preview without writing', default: false },
      autoFix: { type: 'boolean', description: 'Run safe fixes after applying templates', default: true }
    },
    required: ['path'],
    additionalProperties: false
  }
};

export async function execute(args, exec) {
  const cwd = exec.agent?.session?.header?.cwd || process.cwd();
  const filePath = String(args.path || '');
  if (!filePath) return { ok: false, error: { code: 'JAVA_BAD_ARGUMENT', message: 'path is required' } };
  const fullPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const dryRun = args.dryRun === true;

  let content = '';
  let isNewFile = false;
  if (existsSync(fullPath)) {
    const st = statSync(fullPath);
    if (st.isDirectory()) return { ok: false, error: { code: 'JAVA_BAD_ARGUMENT', message: `path is a directory: ${filePath}` } };
    content = readFileSync(fullPath, 'utf8');
  } else {
    isNewFile = true;
  }

  if (isNewFile && content === '') {
    const pkg = args.package || inferPackage(filePath);
    if (pkg) content = `package ${pkg};\n\n`;
  }

  const parsed = parseJavaSource(content, filePath);
  const ops = buildOps(args);
  const result = applyTemplate(content, ops, { parsed });
  let output = result.content;

  if (args.autoFix !== false) {
    const fixed = await autoFix(output, { level: 'safe', dryRun: true, validate: false });
    if (fixed.applied.length) output = fixed.fixed;
  }

  const intentName = args.intent || args.preset;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      path: filePath,
      intent: intentName,
      description: result.description,
      imports: result.imports,
      applied: result.applied,
      preview: output.slice(0, 1400)
    };
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, output, 'utf8');

  return {
    ok: true,
    dryRun: false,
    path: filePath,
    isNewFile,
    intent: intentName,
    description: result.description,
    imports: result.imports,
    applied: result.applied,
    bytes: Buffer.byteLength(output, 'utf8')
  };
}

/**
 * Assemble the ops object from an intent shortcut plus optional granular ops.
 * @param {object} args
 * @returns {object}
 */
function buildOps(args) {
  const ops = { ...(args.ops || {}) };
  const intentName = args.intent || args.preset;
  if (!intentName) return ops;
  const params = { ...(args.params || {}) };
  const SHORTCUTS = [
    'name', 'fields', 'methods', 'constants', 'dependencies', 'permits', 'members', 'routes',
    'basePath', 'entity', 'idType', 'layout', 'table', 'target', 'beanType', 'beanName',
    'builder', 'logger', 'implements', 'extends', 'typeParams', 'annotations', 'body', 'modifiers'
  ];
  for (const key of SHORTCUTS) {
    if (args[key] !== undefined) params[key] = args[key];
  }
  ops.intent = typeof intentName === 'object' ? intentName : { preset: intentName, ...params };
  return ops;
}

export function render(_args, value) {
  if (!value) return 'java_apply: no result';
  if (value.ok === false) return `java_apply error: ${value.error?.message || 'unknown'}`;
  const what = value.intent ? `intent "${value.intent}"` : 'ops';
  const lines = [`${value.dryRun ? 'Preview' : value.isNewFile ? 'Created' : 'Updated'} ${value.path} (${what})`];
  if (value.description) lines.push(value.description);
  if (value.imports?.length) lines.push(`imports: ${value.imports.join(', ')}`);
  if (value.preview) lines.push('', value.preview);
  return lines.join('\n');
}

export const tool = defineTool({ ...schema, execute, render });

export const listTool = defineTool({
  name: 'java_apply_list',
  description: 'List java_apply intents (presets) and granular templates.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => ({ ok: true, presets: listPresets(), templates: listTemplates() }),
  render: (_a, v) => [
    `Intents: ${(v.presets || []).join(', ')}`,
    `Ops: ${(v.templates || []).join(', ')}`
  ].join('\n')
});

export { applyTemplate, listTemplates, listPresets };
