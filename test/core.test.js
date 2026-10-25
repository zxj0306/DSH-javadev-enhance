/**
 * Tests for core utilities
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseJavaSource, findIdentifier, getLineCol, findMatchingBrace, inStringOrComment } from '../core/java-source.js';
import { applyEdits, insert, remove, replace, findImportInsertPos, hasImport, addImport, removeUnusedImports, normalizeEol, restoreEol, ensureFinalNewline, tabsToSpaces } from '../core/edit.js';
import { autoFix } from '../core/fix/engine.js';
import { findJavacSync, checkJavaSource } from '../core/javac.js';
import { applyTemplate, listTemplates, listPresets, expandIntent } from '../core/template/engine.js';
import {
  scanTools, resolveProjectTools, ensureDiscovery, discoveryStatus, clearCache,
  walkDirs, probeJdk, versionFromName, majorOf, compareVersions, unescapeProperty,
  readProjectHints
} from '../core/env/index.js';

const SAMPLE_JAVA = `package com.example;

import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.HashMap;

public class User {
    private long id;
    private String name;
    private String email;

    public User(long id, String name) {
        this.id = id;
        this.name = name;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }
}
`;

describe('java-source.js', () => {
  it('should parse package', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    assert.strictEqual(parsed.package, 'com.example');
  });

  it('should parse imports', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    assert.deepStrictEqual(parsed.imports.sort(), ['java.util.ArrayList', 'java.util.HashMap', 'java.util.List', 'java.util.Map'].sort());
  });

  it('should parse types', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    assert.strictEqual(parsed.types.length, 1);
    assert.strictEqual(parsed.types[0].name, 'User');
    assert.strictEqual(parsed.types[0].keyword, 'class');
  });

  it('should parse fields', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    assert.strictEqual(parsed.fields.length, 3);
    const names = parsed.fields.map(f => f.name).sort();
    assert.deepStrictEqual(names, ['email', 'id', 'name']);
  });

  it('should parse methods', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    assert.strictEqual(parsed.methods.length, 3);
    const names = parsed.methods.map(m => m.name).sort();
    assert.deepStrictEqual(names, ['User', 'getName', 'setName']);
  });

  it('should find identifiers', () => {
    const positions = findIdentifier(SAMPLE_JAVA, 'name');
    assert(positions.length >= 3);
  });

  it('should get line/col', () => {
    const pos = SAMPLE_JAVA.indexOf('public class User');
    const { line } = getLineCol(SAMPLE_JAVA, pos);
    assert.strictEqual(line, 8);
  });

  it('should find matching brace', () => {
    const text = 'class A { void m() { if (true) { return; } } }';
    const firstBrace = text.indexOf('{');
    const match = findMatchingBrace(text, firstBrace);
    assert(match > firstBrace);
    assert.strictEqual(text[match], '}');
  });

  it('should detect string/comment positions', () => {
    const text = 'String s = "hello // not comment"; // real comment';
    assert.strictEqual(inStringOrComment(text, text.indexOf('hello')), true);
    assert.strictEqual(inStringOrComment(text, text.indexOf('real comment')), true);
  });
});

describe('edit.js', () => {
  it('should apply inserts', () => {
    const result = applyEdits('abc', [insert(1, 'X')]);
    assert.strictEqual(result, 'aXbc');
  });

  it('should apply removes', () => {
    const result = applyEdits('abc', [remove(1, 2)]);
    assert.strictEqual(result, 'ac');
  });

  it('should apply replaces', () => {
    const result = applyEdits('abc', [replace(1, 2, 'XY')]);
    assert.strictEqual(result, 'aXYc');
  });

  it('should apply multiple edits in correct order', () => {
    const result = applyEdits('abcdef', [
      insert(2, 'X'),
      insert(5, 'Y')
    ]);
    assert.strictEqual(result, 'abXcdeYf');
  });

  it('should find import insert position', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    const pos = findImportInsertPos(SAMPLE_JAVA, parsed);
    assert(pos > SAMPLE_JAVA.indexOf('import java.util.HashMap'));
    assert(pos < SAMPLE_JAVA.indexOf('public class'));
  });

  it('should detect existing imports', () => {
    assert.strictEqual(hasImport(SAMPLE_JAVA, 'java.util.List'), true);
    assert.strictEqual(hasImport(SAMPLE_JAVA, 'java.util.Set'), false);
  });

  it('should add imports', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    const result = addImport(SAMPLE_JAVA, 'java.util.Set', parsed);
    assert.strictEqual(result.added, true);
    assert(result.content.includes('import java.util.Set;'));
  });

  it('should not add duplicate imports', () => {
    const parsed = parseJavaSource(SAMPLE_JAVA, 'User.java');
    const result = addImport(SAMPLE_JAVA, 'java.util.List', parsed);
    assert.strictEqual(result.added, false);
  });

  it('should remove unused imports', () => {
    const withUnused = SAMPLE_JAVA.replace('import java.util.Map;', 'import java.util.Map;\nimport java.util.Set;');
    const parsed = parseJavaSource(withUnused, 'User.java');
    const result = removeUnusedImports(withUnused, parsed);
    assert(result.removed.includes('java.util.Set'));
    assert(!result.content.includes('import java.util.Set;'));
  });

  it('should normalize EOL', () => {
    const { content, originalEol } = normalizeEol('a\r\nb\r\nc');
    assert.strictEqual(content, 'a\nb\nc');
    assert.strictEqual(originalEol, '\r\n');
    assert.strictEqual(restoreEol(content, originalEol), 'a\r\nb\r\nc');
  });

  it('should ensure final newline', () => {
    assert.strictEqual(ensureFinalNewline('abc'), 'abc\n');
    assert.strictEqual(ensureFinalNewline('abc\n'), 'abc\n');
    assert.strictEqual(ensureFinalNewline('abc\n\n'), 'abc\n');
  });

  it('should convert tabs to spaces', () => {
    assert.strictEqual(tabsToSpaces('\tif (x) {\n\t\ty();\n\t}'), '    if (x) {\n        y();\n    }');
  });
});

describe('fix/engine.js', () => {
  it('should organize imports', async () => {
    const messy = `package test;

import com.example.Foo;
import java.util.Map;
import java.util.List;

public class Test {
    private List<String> items;
    private Map<String, Foo> index;
}
`;
    const result = await autoFix(messy, { level: 'safe', dryRun: true });
    assert(result.applied.some(a => a.rule === 'organizeImports'));
    const javaIdx = result.fixed.indexOf('import java.util');
    const otherIdx = result.fixed.indexOf('import com.example.Foo;');
    assert(javaIdx >= 0 && javaIdx < otherIdx);
  });

  it('should remove duplicate imports', async () => {
    const withDup = `package test;

import java.util.List;
import java.util.List;

public class Test {
    private List<String> items;
}
`;
    const result = await autoFix(withDup, { level: 'safe', dryRun: true });
    assert(result.applied.some(a => a.rule === 'removeDuplicateImports'));
    const count = (result.fixed.match(/import java.util.List;/g) || []).length;
    assert.strictEqual(count, 1);
  });

  it('should add @Override to certain overrides only', async () => {
    const noOverride = `package test;

public class Test {
    public String toString() { return "x"; }

    public void doSomething() {}
}
`;
    const result = await autoFix(noOverride, { level: 'safe', dryRun: true });
    assert(result.applied.some(a => a.rule === 'addOverride'));
    assert(result.fixed.includes('@Override'));
    // doSomething must not be annotated
    assert(!result.fixed.includes('@Override\n    public void doSomething'));
  });

  it('should add serialVersionUID to Serializable', async () => {
    const serializable = `package test;

import java.io.Serializable;

public class Data implements Serializable {
    private String value;
}
`;
    const result = await autoFix(serializable, { level: 'safe', dryRun: true });
    assert(result.applied.some(a => a.rule === 'addSerialVersionUID'));
    assert(result.fixed.includes('serialVersionUID'));
  });

  it('should add missing imports when javac is available', { skip: !findJavacSync() }, async () => {
    const src = `public class NeedsList {\n    private List<String> items;\n}\n`;
    const result = await autoFix(src, { level: 'safe', dryRun: false, validate: true });
    assert(result.fixed.includes('import java.util.List;'), result.fixed);
    assert(result.applied.some((a) => a.rule === 'addMissingImports'));
  });

  it('should normalize whitespace', async () => {
    const messy = 'public class Test{\tprivate int x;\n}';
    const result = await autoFix(messy, { level: 'safe', dryRun: true, tabsToSpaces: true });
    assert(result.applied.some(a => a.rule === 'normalizeWhitespace'));
    assert(!result.fixed.includes('\t'));
  });
});

describe('template/engine.js', () => {
  it('should list templates', () => {
    const templates = listTemplates();
    assert(templates.includes('fields'));
    assert(templates.includes('methods'));
    assert(templates.includes('builder'));
    assert(templates.includes('equalsHashCode'));
    assert(templates.includes('toString'));
    assert(templates.includes('logger'));
    assert(templates.includes('imports'));
    assert(templates.includes('annotations'));
    assert(templates.includes('main'));
    assert(templates.includes('constructors'));
  });

  it('should create a record with builder, equalsHashCode, toString', () => {
    const content = '';
    const result = applyTemplate(content, {
      record: {
        name: 'User',
        fields: [['long', 'id'], ['String', 'name'], ['String', 'email']]
      },
      builder: {},
      equalsHashCode: {},
      toString: {},
      logger: { framework: 'slf4j' }
    });

    assert(result.content.includes('record User(long id, String name, String email)'));
    assert(result.content.includes('UserBuilder'));
    assert(result.content.includes('equals'));
    assert(result.content.includes('hashCode'));
    assert(result.content.includes('toString'));
    assert(result.content.includes('Logger'));
    assert(result.imports.includes('org.slf4j.Logger'));
    assert(result.imports.includes('org.slf4j.LoggerFactory'));
  });

  it('should add fields to existing class', () => {
    const content = `public class User { }`;
    const result = applyTemplate(content, {
      fields: [
        { type: 'long', name: 'id', modifiers: ['private'] },
        { type: 'String', name: 'name', modifiers: ['private'] }
      ]
    });

    assert(result.content.includes('private long id;'));
    assert(result.content.includes('private String name;'));
  });

  it('should add methods to existing class', () => {
    const content = `public class User { }`;
    const result = applyTemplate(content, {
      methods: [
        { name: 'getName', returnType: 'String', body: 'return name;' },
        { name: 'setName', returnType: 'void', params: [{ type: 'String', name: 'name' }], body: 'this.name = name;' }
      ]
    });

    assert(result.content.includes('public String getName()'));
    assert(result.content.includes('public void setName(String name)'));
  });

  it('should add logger', () => {
    const content = `public class Service { }`;
    const result = applyTemplate(content, { logger: { framework: 'slf4j' } });

    assert(result.content.includes('private static final Logger log'));
    assert(result.content.includes('LoggerFactory.getLogger'));
    assert(result.imports.includes('org.slf4j.Logger'));
    assert(result.imports.includes('org.slf4j.LoggerFactory'));
  });

  it('should add equalsHashCode', () => {
    const content = `public class User { private long id; private String name; }`;
    const result = applyTemplate(content, { equalsHashCode: { useObjects: true } });

    assert(result.content.includes('Objects.equals'));
    assert(result.content.includes('Objects.hash'));
    assert(result.imports.includes('java.util.Objects'));
  });

  it('should add toString', () => {
    const content = `public class User { private long id; private String name; }`;
    const result = applyTemplate(content, { toString: {} });

    assert(result.content.includes('toString'));
    assert(result.content.includes('id='));
    assert(result.content.includes('name='));
  });

  it('should create a class with all features', () => {
    const content = '';
    const result = applyTemplate(content, {
      class: {
        name: 'User',
        modifiers: ['public'],
        fields: [
          { type: 'long', name: 'id', modifiers: ['private'] },
          { type: 'String', name: 'name', modifiers: ['private'] }
        ],
        methods: [
          { name: 'getName', returnType: 'String', body: 'return name;' }
        ]
      },
      builder: {},
      equalsHashCode: {},
      toString: {}
    });

    assert(result.content.includes('public class User'));
    assert(result.content.includes('private long id;'));
    assert(result.content.includes('private String name;'));
    assert(result.content.includes('UserBuilder'));
  });
});

describe('env discovery (generic, cross-platform)', () => {
  // Build a fake tool collection that looks exactly like a real install tree.
  // Every assertion below is about *finding* these by inspection only — no
  // machine specific path appears anywhere in the plugin or the tests.
  const tree = makeToolTree();
  const cacheFile = join(tree.root, '.cache', 'discovery.json');
  after(() => { rmSync(tree.root, { recursive: true, force: true }); });

  const options = (extra = {}) => ({
    toolRoots: [tree.root],
    scanDrives: false,
    refresh: true,
    cacheFile,
    budget: 5000,
    timeBudgetMs: 30000,
    ...extra
  });
  const normalizeP = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const treeRoot = normalizeP(tree.root);
  const inTree = (p) => normalizeP(p).startsWith(treeRoot);

  it('finds every JDK in the tree with version and GraalVM flag', async () => {
    const tools = await scanTools(options());
    const found = tools.jdks.filter((j) => inTree(j.javaHome));
    const versions = found.map((j) => j.version).sort();
    assert(versions.includes('17.0.9'), `versions: ${versions}`);
    assert(versions.includes('21.0.2'), `versions: ${versions}`);
    assert(versions.includes('25.0.4'), `versions: ${versions}`);
    const graal = found.find((j) => j.version === '25.0.4');
    assert.strictEqual(graal.isGraal, true);
    assert(inTree(graal.path) && /javac(\.exe)?$/.test(graal.path));
  });

  it('sorts JDKs newest first', async () => {
    const tools = await scanTools(options());
    const found = tools.jdks.filter((j) => inTree(j.javaHome)).map((j) => majorOf(j.version));
    assert.deepStrictEqual([...found].sort((a, b) => b - a), found);
  });

  it('finds Gradle, Android SDK, FFmpeg, LWJGL and IDEA', async () => {
    const tools = await scanTools(options());
    const gradle = tools.gradles.find((g) => inTree(g.gradleHome));
    assert(gradle, 'gradle not found');
    assert.strictEqual(gradle.version, '8.7');

    const sdk = tools.androidSdks.find((s) => inTree(s.path));
    assert(sdk, 'android sdk not found');
    assert.deepStrictEqual(sdk.platforms, ['android-34']);
    assert.deepStrictEqual(sdk.buildTools, ['34.0.0']);
    assert(/adb(\.exe)?$/i.test(sdk.adb));

    const ffmpeg = tools.ffmpegs.find((f) => inTree(f.dir));
    assert(ffmpeg, 'ffmpeg not found');

    const lwjgl = tools.lwjgls.find((l) => inTree(l.libDir));
    assert(lwjgl, 'lwjgl not found');
    assert.strictEqual(lwjgl.lwjgl.length, 2);
    assert.strictEqual(lwjgl.natives.length, 1);
    assert.strictEqual(lwjgl.version, '3.3.6');

    const idea = tools.ideas.find((i) => inTree(i.path));
    assert(idea, 'idea not found');
    assert(/243/.test(idea.version), `idea version: ${idea.version}`);
    assert(idea.formatter);
  });

  it('never walks into dependency/build directories', async () => {
    const tools = await scanTools(options());
    for (const key of ['jdks', 'gradles']) {
      for (const entry of tools[key]) {
        const p = entry.javaHome || entry.gradleHome || '';
        assert(!/node_modules/i.test(p), `walked into ${p}`);
      }
    }
  });

  it('persists the result outside the project and reuses it', async () => {
    await scanTools(options());
    assert(existsSync(cacheFile), 'cache file was not written');

    const status = discoveryStatus({ cacheFile });
    assert.strictEqual(status.present, true);
    assert.strictEqual(status.fresh, true);
    assert(status.counts.jdks >= 3, JSON.stringify(status.counts));

    const reused = await scanTools(options({ refresh: false }));
    assert.strictEqual(reused.cache.fromCache, true);
    assert.strictEqual(reused.cache.file, cacheFile);

    clearCache({ cacheFile });
    const gone = discoveryStatus({ cacheFile });
    assert.strictEqual(gone.present, false);
  });

  it('reports "project" toolchain from the project files it finds', async () => {
    const project = join(tree.root, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'local.properties'), `sdk.dir=${tree.sdk.replace(/\\/g, '/')}\n`, 'utf8');
    writeFileSync(join(project, 'gradle.properties'), `org.gradle.java.home=${tree.jdk17.replace(/\\/g, '/')}\n`, 'utf8');
    writeFileSync(join(project, 'build.gradle'), 'java {\n  toolchain { languageVersion = JavaLanguageVersion.of(17) }\n}\n', 'utf8');
    writeFileSync(join(project, 'gradlew.bat'), '', 'utf8');
    mkdirSync(join(project, 'gradle', 'wrapper'), { recursive: true });
    writeFileSync(join(project, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
      'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip\n', 'utf8');

    const resolved = await resolveProjectTools(project, options());
    assert(/jdk-17\.0\.9/.test(resolved.jdk.javaHome), `jdk: ${resolved.jdk.javaHome}`);
    assert.strictEqual(resolved.jdk.version, '17.0.9');
    assert.strictEqual(resolved.gradle.version, '8.7');
    assert(inTree(resolved.androidSdk.path));
    assert.strictEqual(resolved.androidSdk.source, 'project:local.properties');
    assert.strictEqual(resolved.hints.javaMajor, 17);
    assert.strictEqual(resolved.hints.gradleVersion, '8.7');
    assert(resolved.discovery.cacheFile.endsWith('discovery.json'));
  });

  it('ensureDiscovery stores paths and never throws', async () => {
    const result = await ensureDiscovery(options());
    assert(result && typeof result === 'object', 'expected a result object');
    assert.strictEqual(result.error, null);
    assert(result.counts.jdks >= 3, JSON.stringify(result.counts));
    assert(existsSync(cacheFile));
  });

  it('reads project hints without a cache', () => {
    const hints = readProjectHints(join(tree.root, 'project'));
    assert.strictEqual(hints.javaMajor, 17);
    assert(inTree(hints.javaHome));
    assert.strictEqual(hints.hasWrapper, true);
    assert.strictEqual(hints.gradleVersion, '8.7');
  });

  it('stops walking at the directory budget', () => {
    const walk = walkDirs([tree.root], { budget: 1 });
    assert.strictEqual(walk.visited, 1);
    assert.strictEqual(walk.truncated, true);
  });

  it('parses versions and java properties', () => {
    assert.strictEqual(versionFromName('jdk-21.0.2'), '21.0.2');
    assert.strictEqual(versionFromName('jdk1.8.0_301'), '1.8.0.301');
    assert.strictEqual(versionFromName('graalvm-community-openjdk-21.0.2+13.1'), '21.0.2');
    assert.strictEqual(majorOf('1.8.0_301'), 8);
    assert.strictEqual(majorOf('21.0.2+13'), 21);
    assert(compareVersions('21.0.2', '17.0.9') > 0);
    assert(compareVersions('8.0.1', '8.0.10') < 0);
    assert.strictEqual(unescapeProperty('D\\:\\\\sdk\\\\platforms'), 'D:\\sdk\\platforms');
    assert.strictEqual(probeJdk(tree.jdk21).version, '21.0.2');
    assert.strictEqual(probeJdk(join(tree.root, 'libs')), null);
  });
});

/** Build a realistic tool tree in a temp dir (works on Windows / macOS / Linux). */
function makeToolTree() {
  const root = mkdtempSync(join(tmpdir(), 'java-dev-env-'));
  const write = (rel, content = '') => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
    return p;
  };
  write('jdk-21.0.2/release', 'JAVA_VERSION="21.0.2"\n');
  write('jdk-21.0.2/bin/javac');
  write('jdk-21.0.2/bin/javac.exe');
  write('jdk-21.0.2/bin/java.exe');
  write('toolchain/jdk-17.0.9/release', 'JAVA_VERSION="17.0.9"\n');
  write('toolchain/jdk-17.0.9/bin/javac.exe');
  write('toolchain/jdk-17.0.9/bin/javac');
  write('graalvm/graalvm-jdk-25.0.4/release', 'JAVA_VERSION="25.0.4"\nGRAALVM_VERSION="25"\nJVMCI=yes\n');
  write('graalvm/graalvm-jdk-25.0.4/bin/javac.exe');
  write('gradle-8.7/bin/gradle.bat');
  write('gradle-8.7/bin/gradle');
  write('gradle-8.7/lib/gradle-launcher-8.7.jar');
  write('android-sdk/platform-tools/adb.exe');
  write('android-sdk/platform-tools/adb');
  mkdirSync(join(root, 'android-sdk', 'platforms', 'android-34'), { recursive: true });
  mkdirSync(join(root, 'android-sdk', 'build-tools', '34.0.0'), { recursive: true });
  write('android-sdk/cmdline-tools/latest/bin/sdkmanager.bat');
  write('ffmpeg/bin/ffmpeg.exe');
  write('ffmpeg/bin/ffmpeg');
  write('libs/lwjgl-3.3.6.jar');
  write('libs/lwjgl-glfw-3.3.6.jar');
  write('libs/lwjgl-3.3.6-natives-windows.jar');
  write('IntelliJ IDEA 2024.3/bin/format.bat');
  write('IntelliJ IDEA 2024.3/bin/format.sh');
  write('IntelliJ IDEA 2024.3/bin/idea64.exe');
  write('IntelliJ IDEA 2024.3/build.txt', 'IU-243.21565.193\n');
  // Decoys: a dependency directory must never be treated as a tool location.
  write('node_modules/some-dep/jdk-99/bin/javac');
  write('node_modules/some-dep/lib/gradle-1.0/bin/gradle.bat');
  return {
    root,
    jdk21: join(root, 'jdk-21.0.2'),
    jdk17: join(root, 'toolchain', 'jdk-17.0.9'),
    graal: join(root, 'graalvm', 'graalvm-jdk-25.0.4'),
    gradle: join(root, 'gradle-8.7'),
    sdk: join(root, 'android-sdk'),
    libs: join(root, 'libs')
  };
}

describe('template presets (minimal intents)', () => {
  const gen = (intent) => applyTemplate('', { intent }, { parsed: parseJavaSource('') }).content;

  it('should list presets', () => {
    const presets = listPresets();
    for (const name of ['pojo', 'immutable', 'record', 'recordBuilder', 'dto', 'entity', 'service',
      'controller', 'repository', 'test', 'singleton', 'exception', 'main', 'enum', 'interface',
      'annotation', 'sealed', 'config', 'activity', 'util', 'constant']) {
      assert(presets.includes(name), `missing preset ${name}`);
    }
  });

  it('pojo preset generates accessors and value methods', () => {
    const out = gen({ preset: 'pojo', name: 'User', fields: [['Long', 'id'], ['String', 'name']] });
    assert(out.includes('public class User'));
    assert(out.includes('private Long id;'));
    assert(out.includes('public Long getId()'));
    assert(out.includes('public void setName(String name)'));
    assert(out.includes('public boolean equals(Object obj)'));
    assert(out.includes('public int hashCode()'));
    assert(out.includes('public String toString()'));
    assert(out.includes('import java.util.Objects;'));
  });

  it('immutable preset uses final fields and public constructor', () => {
    const out = gen({ preset: 'immutable', name: 'Point', fields: [['int', 'x'], ['int', 'y']] });
    assert(out.includes('public final class Point'));
    assert(out.includes('private final int x;'));
    assert(out.includes('public Point(int x, int y)'));
    assert(out.includes('if (this.x != that.x) return false;'));
  });

  it('record preset accepts shorthand string and builder', () => {
    const out = gen({ preset: 'record', name: 'Order', fields: [['long', 'id'], ['String', 'sku']], builder: true });
    assert(out.includes('public record Order(long id, String sku)'));
    assert(out.includes('OrderBuilder'));
  });

  it('record shorthand string form', () => {
    const out = applyTemplate('', { record: 'User(long id, String name)' }, { parsed: parseJavaSource('') }).content;
    assert(out.includes('record User(long id, String name)'));
  });

  it('enum shorthand string form', () => {
    const out = applyTemplate('', { enum: 'Color: RED,GREEN' }, { parsed: parseJavaSource('') }).content;
    assert(out.includes('enum Color'));
    assert(out.includes('RED, GREEN'));
  });

  it('intent string with top-level shortcuts', () => {
    const out = gen({ intent: 'pojo', name: 'Item', fields: ['Long id', 'String label'] });
    assert(out.includes('class Item'));
    assert(out.includes('private Long id;'));
    assert(out.includes('private String label;'));
  });

  it('expandIntent merges granular ops over a preset', () => {
    const expanded = expandIntent({ intent: 'pojo', name: 'A', fields: [['int', 'x']], logger: true });
    assert(expanded.ops.class.name === 'A');
    assert(expanded.ops.getLogger === undefined && expanded.ops.logger);
    assert(expanded.ops.getters);
  });

  it('getters/setters are idempotent', () => {
    const once = applyTemplate('', { class: { name: 'A', fields: [['String', 'name']] }, getters: {}, setters: {} },
      { parsed: parseJavaSource('') }).content;
    const twice = applyTemplate(once, { getters: {}, setters: {} }, { parsed: parseJavaSource(once) }).content;
    assert.strictEqual((twice.match(/String getName\(\)/g) || []).length, 1);
    assert.strictEqual((twice.match(/void setName\(String name\)/g) || []).length, 1);
  });

  it('javadoc and compact constructor', () => {
    const out = applyTemplate('', {
      record: { name: 'User', fields: [['String', 'name']] },
      compactConstructor: {},
      javadoc: { target: 'class', text: 'A user.' }
    }, { parsed: parseJavaSource('') }).content;
    assert(out.includes('/**'));
    assert(out.includes('A user.'));
    assert(out.includes('public User {'));
    assert(out.includes('if (name == null)'));
  });

  it('sealed preset nests permitted subtypes', () => {
    const out = gen({ preset: 'sealed', name: 'Shape', permits: ['Circle', 'Square'] });
    assert(out.includes('public sealed class Shape'));
    assert(out.includes('permits Shape.Circle, Shape.Square'));
    assert(out.includes('class Circle extends Shape'));
    assert(out.includes('class Square extends Shape'));
  });

  it('annotation preset', () => {
    const out = gen({ preset: 'annotation', name: 'Marker', members: [{ type: 'String', name: 'value' }] });
    assert(out.includes('public @interface Marker'));
    assert(out.includes('String value();'));
  });

  it('service preset adds annotations, logger and constructor injection', () => {
    const out = gen({ preset: 'service', name: 'UserService', dependencies: [['UserRepository', 'repo']] });
    assert(out.includes('@Service'));
    assert(out.includes('private final UserRepository repo;'));
    assert(out.includes('public UserService(UserRepository repo)'));
    assert(out.includes('private static final Logger log'));
  });

  it('entity preset adds JPA annotations', () => {
    const out = gen({ preset: 'entity', name: 'Customer', fields: [['String', 'email']] });
    assert(out.includes('@Entity'));
    assert(out.includes('@Table(name = "customers")'));
    assert(out.includes('@Id'));
    assert(out.includes('private Long id;'));
  });

  it('test preset adds JUnit methods', () => {
    const out = gen({ preset: 'test', name: 'UserTest', target: 'User' });
    assert(out.includes('@Test'));
    assert(out.includes('void shouldWork()'));
    assert(out.includes('import org.junit.jupiter.api.Test;'));
  });

  it('singleton/exception/util/constant/main/enum/interface/dto presets produce types', () => {
    const cases = [
      ['singleton', { name: 'Config', fields: [['String', 'env']] }, 'public static Config getInstance()'],
      ['exception', { name: 'BadThing' }, 'public BadThing(String message)'],
      ['util', { name: 'Strings' }, 'private Strings()'],
      ['constant', { name: 'Limits', constants: [['int', 'MAX', '10']] }, 'public static final int MAX = 10;'],
      ['main', { name: 'App' }, 'public static void main(String[] args)'],
      ['enum', { name: 'Color', constants: ['RED', 'GREEN'] }, 'RED, GREEN'],
      ['interface', { name: 'Handler', methods: [{ returnType: 'void', name: 'handle' }] }, 'void handle();'],
      ['dto', { name: 'UserDto', fields: [['Long', 'id']] }, 'public UserDto()']
    ];
    for (const [preset, params, needle] of cases) {
      const out = gen({ preset, ...params });
      assert(out.includes(needle), `${preset} output missing ${needle}\n${out}`);
    }
  });

  it('pojo preset is idempotent (no duplicate type or members)', () => {
    const first = gen({ preset: 'pojo', name: 'User', fields: [['Long', 'id'], ['String', 'name']] });
    const second = applyTemplate(first, { intent: 'pojo', name: 'User', fields: [['Long', 'id'], ['String', 'name']] },
      { parsed: parseJavaSource(first) }).content;
    // Only one public class User
    assert.strictEqual((second.match(/public class User/g) || []).length, 1, 'duplicate class\n' + second);
    // Fields not duplicated
    assert.strictEqual((second.match(/private Long id;/g) || []).length, 1, 'duplicate field id\n' + second);
    assert.strictEqual((second.match(/private String name;/g) || []).length, 1, 'duplicate field name\n' + second);
    // Accessors/value methods not duplicated
    assert.strictEqual((second.match(/public Long getId\(\)/g) || []).length, 1, 'duplicate getter\n' + second);
    assert.strictEqual((second.match(/public void setName\(String name\)/g) || []).length, 1, 'duplicate setter\n' + second);
    assert.strictEqual((second.match(/public boolean equals\(Object obj\)/g) || []).length, 1, 'duplicate equals\n' + second);
    assert.strictEqual((second.match(/public int hashCode\(\)/g) || []).length, 1, 'duplicate hashCode\n' + second);
    assert.strictEqual((second.match(/public String toString\(\)/g) || []).length, 1, 'duplicate toString\n' + second);
  });

  it('fields/methods/constructors are idempotent on existing type', () => {
    const once = applyTemplate('', { class: { name: 'A', fields: [{ type: 'String', name: 'name', modifiers: ['private'] }] },
      methods: [{ name: 'doWork', returnType: 'void', body: '' }] },
      { parsed: parseJavaSource('') }).content;
    const twice = applyTemplate(once, { fields: [{ type: 'String', name: 'name', modifiers: ['private'] }],
      methods: [{ name: 'doWork', returnType: 'void', body: '' }] },
      { parsed: parseJavaSource(once) }).content;
    assert.strictEqual((twice.match(/private String name;/g) || []).length, 1, 'duplicate field\n' + twice);
    assert.strictEqual((twice.match(/void doWork\(\)/g) || []).length, 1, 'duplicate method\n' + twice);
  });

  it('intent class plus top-level ops.class merges without duplicate type', () => {
    // Intent alone generates a public class; adding a same-name class op should not
    // create a second type, it should fold members into the existing one.
    const out = applyTemplate('', { intent: 'pojo', name: 'Cfg', fields: [{ type: 'String', name: 'key', modifiers: ['private'] }] },
      { parsed: parseJavaSource('') }).content;
    assert.strictEqual((out.match(/public class Cfg/g) || []).length, 1, 'duplicate class Cfg\n' + out);
    assert(out.includes('private String key;'), 'missing field key\n' + out);
    // Re-applying the same intent must not duplicate anything.
    const twice = applyTemplate(out, { intent: 'pojo', name: 'Cfg', fields: [{ type: 'String', name: 'key', modifiers: ['private'] }] },
      { parsed: parseJavaSource(out) }).content;
    assert.strictEqual((twice.match(/public class Cfg/g) || []).length, 1, 'second application duplicated class\n' + twice);
    assert.strictEqual((twice.match(/private String key;/g) || []).length, 1, 'second application duplicated field\n' + twice);
  });

  it('singleton/toString/equalsHashCode are idempotent', () => {
    let src = applyTemplate('', { class: { name: 'Svc' }, singleton: { name: 'Svc' } },
      { parsed: parseJavaSource('') }).content;
    src = applyTemplate(src, { singleton: { name: 'Svc' } }, { parsed: parseJavaSource(src) }).content;
    assert.strictEqual((src.match(/public static Svc getInstance\(\)/g) || []).length, 1, 'duplicate getInstance\n' + src);

    src = applyTemplate('', { class: { name: 'Val', fields: [{ type: 'String', name: 'x', modifiers: ['private'] }] }, toString: {} },
      { parsed: parseJavaSource('') }).content;
    src = applyTemplate(src, { toString: {} }, { parsed: parseJavaSource(src) }).content;
    assert.strictEqual((src.match(/public String toString\(\)/g) || []).length, 1, 'duplicate toString\n' + src);

    src = applyTemplate('', { class: { name: 'Eq', fields: [{ type: 'String', name: 'x', modifiers: ['private'] }] }, equalsHashCode: {} },
      { parsed: parseJavaSource('') }).content;
    src = applyTemplate(src, { equalsHashCode: {} }, { parsed: parseJavaSource(src) }).content;
    assert.strictEqual((src.match(/public boolean equals\(Object obj\)/g) || []).length, 1, 'duplicate equals\n' + src);
    assert.strictEqual((src.match(/public int hashCode\(\)/g) || []).length, 1, 'duplicate hashCode\n' + src);
  });
});

describe('import safety', () => {
  it('never removes static or wildcard imports (and keeps Javadoc references)', async () => {
    const src = `package demo;

import java.util.List;
import static java.lang.Math.max;
import static org.junit.jupiter.api.Assertions.*;
import java.util.Optional;

public class I {
    /** @see Optional */
    private List<String> items;

    int bigger(int a, int b) {
        return max(a, b);
    }
}
`;
    const result = await autoFix(src, { level: 'safe', dryRun: true, validate: false });
    assert(result.fixed.includes('import static java.lang.Math.max;'), result.fixed);
    assert(result.fixed.includes('import static org.junit.jupiter.api.Assertions.*;'), result.fixed);
    assert(result.fixed.includes('import java.util.Optional;'), result.fixed);
    assert(result.fixed.includes('import java.util.List;'), result.fixed);
  });

  it('still removes genuinely unused normal imports and dedupes', async () => {
    const src = `package demo;

import java.util.List;
import java.util.Map;
import java.util.List;

public class I {
    private List<String> x;
}
`;
    const result = await autoFix(src, { level: 'safe', dryRun: true, validate: false });
    assert(!result.fixed.includes('import java.util.Map;'), result.fixed);
    assert.strictEqual((result.fixed.match(/import java\.util\.List;/g) || []).length, 1);
  });
});

describe('high-performance presets', () => {
  const gen = (intent) => applyTemplate('', { intent }, { parsed: parseJavaSource('') }).content;

  it('lists high-performance intents', () => {
    const presets = listPresets();
    for (const name of ['benchmark', 'ringbuf', 'objectpool', 'soa', 'mat4', 'gameloop',
      'framebuffer', 'parallel', 'arena', 'lwjgl', 'noise']) {
      assert(presets.includes(name), `missing preset ${name}`);
    }
  });

  it('generates expected shapes', () => {
    assert(gen({ preset: 'ringbuf', name: 'SpscRingBuffer' }).includes('class SpscRingBuffer<T>'));
    assert(gen({ preset: 'ringbuf', name: 'R' }).includes('head.lazySet'));
    assert(gen({ preset: 'soa', name: 'P', fields: [['float', 'x']] }).includes('float[] x;'));
    assert(gen({ preset: 'mat4', name: 'Mat4' }).includes('public void multiply'));
    assert(gen({ preset: 'gameloop', name: 'Loop' }).includes('FIXED_DT'));
    assert(gen({ preset: 'framebuffer', name: 'Fb' }).includes('int[] pixels'));
    assert(gen({ preset: 'parallel', name: 'PF' }).includes('IntStream.range(0, chunks).parallel()'));
    assert(gen({ preset: 'arena', name: 'A' }).includes('allocateDirect'));
    assert(gen({ preset: 'noise', name: 'N' }).includes('noise2'));
    assert(gen({ preset: 'benchmark', name: 'B' }).includes('System.nanoTime()'));
    const gl = gen({ preset: 'lwjgl', name: 'GlApp' });
    assert(gl.includes('org.lwjgl.glfw.GLFW'));
    assert(gl.includes('glfwCreateWindow'));
  });

  it('generated high-performance classes compile', { skip: !findJavacSync() }, async () => {
    const cases = [
      { preset: 'benchmark', name: 'Bench' },
      { preset: 'ringbuf', name: 'SpscRingBuffer' },
      { preset: 'objectpool', name: 'ObjectPool' },
      { preset: 'soa', name: 'ParticleSoA', fields: [['float', 'x'], ['float', 'y'], ['float', 'vx'], ['float', 'vy']] },
      { preset: 'mat4', name: 'Mat4' },
      { preset: 'gameloop', name: 'GameLoop' },
      { preset: 'framebuffer', name: 'Framebuffer' },
      { preset: 'parallel', name: 'ParallelFor' },
      { preset: 'arena', name: 'Arena' },
      { preset: 'noise', name: 'ValueNoise' }
    ];
    for (const intent of cases) {
      const result = await checkJavaSource(gen(intent));
      const diagnostics = (result.diagnostics || []).map((d) => d.message + (d.detail ? ' :: ' + d.detail : '')).join('\n');
      assert(result.success, `${intent.preset} failed to compile:\n${diagnostics}`);
    }
  });
});

console.log('All tests defined. Run with: node --test test/core.test.js');