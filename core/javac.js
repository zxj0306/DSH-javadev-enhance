/**
 * Javac wrapper for parsing and validating Java code.
 * Uses the JDK's javac with -proc:none for fast syntactic checking.
 */

import { spawn, spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { probeJdk } from './env/probe.js';
import { standardRoots, whichSync, readDir, isFile, fixedDrives, isDir, readText } from './env/platform.js';
import { loadDiscovery, defaultCacheFile } from './env/store.js';

let javacMemo;
const majorMemo = new Map();

/**
 * Runtime major version of a javac binary (`javac 25.0.3` -> 25).
 * Cached per process: `--release` availability depends on it, and a JDK that is
 * older than the requested source level must not hard-fail the check.
 */
export function javacMajor(javacPath) {
  if (!javacPath) return 0;
  if (majorMemo.has(javacPath)) return majorMemo.get(javacPath);
  let major = 0;
  const release = readText(join(dirname(dirname(javacPath)), 'release'));
  const fromRelease = release && release.match(/JAVA_VERSION="(?:1\.)?(\d+)/);
  if (fromRelease) major = Number(fromRelease[1]);
  if (!major) {
    try {
      const r = spawnSync(javacPath, ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const m = (r.stdout || r.stderr || '').match(/javac\s+(?:1\.)?(\d+)/);
      if (m) major = Number(m[1]);
    } catch { /* unknown */ }
  }
  majorMemo.set(javacPath, major);
  return major;
}

/** A JDK home is "complete" when it carries lib/modules (so --release works). */
function isComplete(jdk) {
  const home = jdk.javaHome || dirname(dirname(jdk.path));
  return isDir(join(home, 'lib')) || isDir(join(home, 'jmods'));
}

/**
 * Find a javac executable without hard-coding any machine specific path.
 *
 * Candidates come from explicit roots, JAVA_HOME/JDK_HOME, the stored discovery
 * result, PATH and the platform's standard JDK directories. They are scored so
 * a complete JDK always wins over a bare `bin` directory that only happens to
 * be on PATH.
 *
 * @param {string[]} toolRoots directories that are either a JDK home or contain JDKs
 * @returns {string|null}
 */
export function findJavacSync(toolRoots = []) {
  const roots = Array.isArray(toolRoots) ? toolRoots : [];
  const memoKey = roots.join('|');
  if (javacMemo && javacMemo.key === memoKey) return javacMemo.path;

  const candidates = [];
  const push = (jdk, bonus) => { if (jdk) candidates.push({ ...jdk, bonus }); };

  const direct = [...roots, process.env.JAVA_HOME, process.env.JDK_HOME].filter(Boolean);
  for (const root of direct) {
    push(probeJdk(root), 3);
    for (const entry of readDir(root)) push(probeJdk(join(root, entry)), 2);
  }

  const stored = loadDiscovery(defaultCacheFile());
  if (stored) {
    for (const jdk of stored.tools?.jdks || []) {
      if (jdk.path && isFile(jdk.path)) candidates.push({ ...jdk, bonus: 2 });
    }
  }

  const onPath = whichSync('javac');
  if (onPath && isFile(onPath)) {
    candidates.push({ path: onPath, javaHome: dirname(dirname(onPath)), bonus: 1 });
  }

  for (const root of [...standardRoots(), ...fixedDrives()]) {
    push(probeJdk(root), 1);
    for (const entry of readDir(root)) push(probeJdk(join(root, entry)), 0);
  }

  if (!candidates.length) return memoize(memoKey, null);

  const best = candidates
    .map((c) => ({ ...c, score: scoreJdk(c) }))
    .sort((a, b) => b.score - a.score)[0];
  return memoize(memoKey, best ? best.path : null);
}

function scoreJdk(candidate) {
  const complete = isComplete(candidate) ? 100 : 0;
  const major = javacMajor(candidate.path);
  return complete + (candidate.bonus || 0) * 10 + Math.min(major, 99) / 100;
}

function memoize(key, path) {
  javacMemo = { key, path, at: Date.now() };
  return path;
}

/** Delete a check's scratch dir (best effort). */
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Compile Java source with javac and capture diagnostics.
 *
 * The `--release` level is clamped to the capabilities of the discovered JDK and
 * retried without `--release` when the binary does not support it, so a partial
 * JDK on PATH cannot break validation.
 *
 * @param {string} sourceCode
 * @param {object} options
 * @returns {Promise<{success:boolean, diagnostics:Array, errors:number, warnings:number}>}
 */
export async function checkJavaSource(sourceCode, options = {}) {
  const {
    javacPath = findJavacSync(options.toolRoots),
    classpath = [],
    sourceLevel = '21'
  } = options;

  if (!javacPath) {
    return { success: false, diagnostics: [], errors: 0, warnings: 0, error: 'javac not found' };
  }

  // Name the temp file after the public type, otherwise javac adds a spurious
  // "public class should be declared in <Name>.java" error to every check.
  const publicType = sourceCode.match(/\bpublic\s+(?:final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/);
  const fileName = `${publicType ? publicType[1] : 'Test'}.java`;
  const want = Number(sourceLevel) || 21;
  const major = javacMajor(javacPath);
  const level = major > 0 && want > major ? major : want;

  const attempt = async (release) => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'javac-check-'));
    const srcFile = resolve(tempDir, fileName);
    writeFileSync(srcFile, sourceCode, 'utf8');
    const cp = classpath.length ? ['-cp', classpath.join(process.platform === 'win32' ? ';' : ':')] : [];
    const args = [
      '-J-Duser.language=en',
      '-J-Duser.country=US',
      '-encoding', 'UTF-8',
      '-proc:none',
      ...(release ? ['--release', String(release)] : []),
      '-d', tempDir,
      ...cp,
      srcFile
    ];
    return new Promise((done) => {
      const proc = spawn(javacPath, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => {
        const output = stdout + stderr;
        const diagnostics = parseJavacOutput(output);
        const errors = diagnostics.filter((d) => d.kind === 'error').length;
        const warnings = diagnostics.filter((d) => d.kind === 'warning').length;
        cleanup(tempDir);
        done({ success: code === 0, diagnostics, errors, warnings, rawOutput: output, release: release ?? null });
      });
      proc.on('error', (err) => {
        cleanup(tempDir);
        done({ success: false, diagnostics: [], errors: 0, warnings: 0, error: err.message, rawOutput: '', release: release ?? null });
      });
    });
  };

  const first = await attempt(level);
  if (first.success) return first;
  // A JDK without lib/ct.sym (or an older one) rejects --release: retry plainly.
  if (/release version\s+\d+\s+not supported|invalid source release|invalid target release/i.test(first.rawOutput || '')) {
    return attempt(null);
  }
  return first;
}


/**
 * Parse javac output into structured diagnostics.
 * @param {string} output
 * @returns {Array}
 */
export function parseJavacOutput(output) {
  const lines = output.split(/\r?\n/);
  const diagnostics = [];
  const filePattern = /^(.+?\.java):(\d+):\s*(error|warning|note):\s*(.+)$/;
  const caretPattern = /^\s*\^/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(filePattern);
    if (!match) continue;
    const [, file, lineStr, kind, message] = match;

    // Collect the indented detail lines that follow (they carry the symbol name).
    let detail = '';
    let column = 0;
    let j = i + 1;
    while (j < lines.length && !filePattern.test(lines[j])) {
      if (!column && caretPattern.test(lines[j])) column = lines[j].indexOf('^') + 1;
      detail += ' ' + lines[j].trim();
      j++;
    }

    const symbol = detail.match(/symbol:\s+(?:(?:class|interface|enum|annotation|variable|method)\s+)?([\w$]+)/);
    diagnostics.push({
      file: file.replace(/\\/g, '/'),
      line: parseInt(lineStr, 10),
      column,
      kind: kind === 'note' ? 'info' : kind,
      message: message.trim(),
      detail: detail.trim(),
      ...(symbol ? { symbol: symbol[1] } : {})
    });
    i = j - 1;
  }
  return diagnostics;
}

/**
 * Extract unresolved simple names from javac diagnostics.
 * @param {Array} diagnostics
 * @returns {string[]}
 */
export function findMissingSymbols(diagnostics) {
  const missing = new Set();
  for (const d of diagnostics) {
    if (d.kind !== 'error') continue;
    if (d.symbol) {
      missing.add(d.symbol);
      continue;
    }
    if (!d.message.includes('cannot find symbol')) continue;
    const combined = `${d.message} ${d.detail || ''}`;
    const m = combined.match(/symbol:\s+(?:(?:class|interface|enum|annotation|variable|method)\s+)?([\w$]+)/);
    if (m) missing.add(m[1]);
  }
  return [...missing];
}

/**
 * Check whether the given source compiles without errors.
 * @param {string} sourceCode
 * @param {object} options
 * @returns {Promise<boolean>}
 */
export async function compilesClean(sourceCode, options = {}) {
  const result = await checkJavaSource(sourceCode, options);
  return result.success;
}
