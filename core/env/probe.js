/**
 * Per-tool probes. Each probe answers "is this directory a JDK / Gradle /
 * Android SDK / FFmpeg install / LWJGL lib dir / IntelliJ IDEA?" and returns a
 * normalised entry or null.
 *
 * Probes are pure directory inspection (no spawning) so they are cheap enough
 * to call for every directory the walker visits. The only exception is the
 * FFmpeg version string, which is only read when `detail` is requested.
 */

import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  exists, isDir, isFile, readText, readDir, readDirEntries, realpathSafe,
  exeNames, isWin, isMac, fixedDrives, envHints, whichSync
} from './platform.js';

/** `jdk-21.0.1` / `jdk1.8.0_301` / `graalvm-community-openjdk-21.0.2+13.1` / `zulu21.30.15` */
export function versionFromName(name) {
  if (!name) return null;
  const graal = name.match(/graalvm[^0-9]*(\d+(?:\.\d+)*)/i);
  if (graal) return graal[1];
  const dotted = name.match(/(\d+\.\d+(?:\.\d+)*(?:[_-]\w+)?)/);
  if (dotted) return dotted[1].replace('_', '.');
  const major = name.match(/(?:jdk|java|jre)[- _]?(\d{1,3})/i);
  return major ? major[1] : null;
}

/** Read `JAVA_VERSION` from a JDK `release` file. */
function jdkVersionFromRelease(javaHome) {
  const release = readText(join(javaHome, 'release'));
  if (!release) return { version: null, isGraal: false };
  const m = release.match(/JAVA_VERSION="([^"]+)"/);
  const isGraal = /GRAALVM|JVMCI/i.test(release);
  return { version: m ? m[1] : null, isGraal };
}

/** macOS JDK bundles keep the real home under `Contents/Home`. */
function jdkHomes(dir) {
  const homes = [];
  if (exists(join(dir, 'bin'))) homes.push(dir);
  if (exists(join(dir, 'Contents', 'Home', 'bin'))) homes.push(join(dir, 'Contents', 'Home'));
  return homes;
}

/**
 * @param {string} dir
 * @param {string} [source]
 * @returns {object|null} `{ path, javaHome, version, isGraal, source }`
 */
export function probeJdk(dir, source = 'scan') {
  for (const home of jdkHomes(dir)) {
    for (const name of exeNames('javac')) {
      const javac = join(home, 'bin', name);
      if (!isFile(javac)) continue;
      const { version, isGraal } = jdkVersionFromRelease(home);
      return {
        path: realpathSafe(javac),
        javaHome: realpathSafe(home),
        version: version || versionFromName(basename(dir)) || 'unknown',
        isGraal: isGraal || /graal/i.test(dir),
        // A bare `bin` directory on PATH (no lib/ or jmods/) cannot do --release.
        partial: !(isDir(join(home, 'lib')) || isDir(join(home, 'jmods'))),
        source
      };
    }
  }
  return null;
}

/**
 * @param {string} dir
 * @param {string} [source]
 */
export function probeGradle(dir, source = 'scan') {
  for (const name of exeNames('gradle')) {
    const exePath = join(dir, 'bin', name);
    if (!isFile(exePath)) continue;
    let version = null;
    for (const f of readDir(join(dir, 'lib'))) {
      const m = f.match(/gradle-launcher-([\d.]+(?:-[a-z0-9]+)?)\.jar/i);
      if (m) { version = m[1]; break; }
    }
    if (!version) {
      for (const f of readDir(join(dir, 'lib'))) {
        const m = f.match(/^gradle-([\d.]+(?:-[a-z0-9]+)?)\.jar$/i);
        if (m) { version = m[1]; break; }
      }
    }
    return {
      path: realpathSafe(exePath),
      gradleHome: realpathSafe(dir),
      version: version || versionFromName(basename(dir)) || 'unknown',
      source
    };
  }
  return null;
}

/**
 * Android SDK: either a `platform-tools/adb` or the classic
 * `platforms/` + `build-tools/` layout.
 * @param {string} dir
 * @param {string} [source]
 */
export function probeAndroidSdk(dir, source = 'scan') {
  const adb = exeNames('adb').map((n) => join(dir, 'platform-tools', n)).find((p) => isFile(p)) || null;
  const platformsDir = join(dir, 'platforms');
  const buildToolsDir = join(dir, 'build-tools');
  if (!adb && !(isDir(platformsDir) && isDir(buildToolsDir))) return null;
  const platforms = readDir(platformsDir).filter((d) => /^android-/.test(d)).sort();
  const buildTools = readDir(buildToolsDir).filter((d) => /^\d/.test(d)).sort();
  const cmdlineRoot = join(dir, 'cmdline-tools');
  const cmdlineDir = readDir(cmdlineRoot).filter((d) => isDir(join(cmdlineRoot, d)))[0] || null;
  const sdkmanager = cmdlineDir
    ? exeNames('sdkmanager').map((n) => join(cmdlineRoot, cmdlineDir, 'bin', n)).find((p) => isFile(p)) || null
    : null;
  const emulator = exeNames('emulator').map((n) => join(dir, 'emulator', n)).find((p) => isFile(p)) || null;
  return {
    path: realpathSafe(dir),
    adb: adb ? realpathSafe(adb) : null,
    platforms,
    buildTools,
    latestPlatform: platforms[platforms.length - 1] || null,
    latestBuildTools: buildTools[buildTools.length - 1] || null,
    sdkmanager,
    emulator,
    ndk: readDir(join(dir, 'ndk')).filter((d) => /^\d/.test(d)).sort().pop() || null,
    source
  };
}

/** FFmpeg binary; version only read when `detail`. */
export function probeFfmpeg(dir, source = 'scan', detail = false) {
  let bin = null;
  for (const name of exeNames('ffmpeg')) {
    for (const candidate of [join(dir, name), join(dir, 'bin', name)]) {
      if (isFile(candidate)) { bin = candidate; break; }
    }
    if (bin) break;
  }
  if (!bin) return null;
  let version = versionFromName(basename(dir));
  if (detail) {
    try {
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const m = (r.stdout || '').match(/ffmpeg version (\S+)/i);
      if (m) version = m[1];
    } catch { /* keep name-derived version */ }
  }
  const probe = exeNames('ffprobe').map((n) => join(dirname(bin), n)).find((p) => isFile(p)) || null;
  return { path: realpathSafe(bin), dir: realpathSafe(dir), version: version || 'unknown', ffprobe: probe ? realpathSafe(probe) : null, source };
}

/** LWJGL / OpenGL jars living in a lib-ish directory. */
export function probeLwjgl(dir, source = 'scan') {
  const jars = readDir(dir).filter((f) => /^lwjgl.*\.jar$/i.test(f));
  if (!jars.length) return null;
  const full = jars.map((f) => join(dir, f));
  const natives = full.filter((f) => /natives/i.test(basename(f)));
  const libs = full.filter((f) => !/natives/i.test(basename(f)));
  const version = (jars.join(' ').match(/lwjgl(?:-[a-z]+)?-(\d+(?:\.\d+)+)/i) || [])[1] || null;
  return {
    libDir: realpathSafe(dir),
    displayName: basename(dirname(dir)) ? `${basename(dirname(dir))}/${basename(dir)}` : dir,
    lwjgl: libs,
    natives,
    version,
    source
  };
}

/** IntelliJ IDEA (formatter / inspect command line tools). */
export function probeIdea(dir, source = 'scan') {
  const bin = join(dir, 'bin');
  if (!isDir(bin)) return null;
  const has = (names) => names.map((n) => join(bin, n)).find((p) => isFile(p)) || null;
  const formatter = has(['format.bat', 'format.sh', 'format.cmd']);
  const inspect = has(['inspect.bat', 'inspect.sh']);
  const idea = has(['idea64.exe', 'idea.exe', 'idea.sh', 'idea']);
  if (!formatter && !inspect && !idea) return null;
  const buildTxt = readText(join(dir, 'build.txt'));
  const version = buildTxt
    ? (buildTxt.trim().split(/\s+/).pop() || null)
    : versionFromName(basename(dir)) || null;
  return {
    path: realpathSafe(dir),
    version: version || 'unknown',
    formatter: formatter ? realpathSafe(formatter) : null,
    inspect: inspect ? realpathSafe(inspect) : null,
    idea: idea ? realpathSafe(idea) : null,
    source
  };
}

/** System OpenGL / Vulkan runtimes (informational). */
export function probeSystemGraphics() {
  const found = [];
  if (isWin) {
    for (const name of ['opengl32.dll', 'glu32.dll']) {
      const p = join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
      if (isFile(p)) found.push({ kind: 'opengl', path: p });
    }
  } else if (isMac) {
    if (isDir('/System/Library/Frameworks/OpenGL.framework')) found.push({ kind: 'opengl', path: '/System/Library/Frameworks/OpenGL.framework' });
    if (isDir('/System/Library/Frameworks/Metal.framework')) found.push({ kind: 'metal', path: '/System/Library/Frameworks/Metal.framework' });
  } else {
    for (const dir of ['/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib', '/usr/lib/aarch64-linux-gnu']) {
      if (!isDir(dir)) continue;
      const hit = ['libGL.so', 'libGL.so.1', 'libOpenGL.so.0'].find((n) => exists(join(dir, n)));
      if (hit) { found.push({ kind: 'opengl', path: join(dir, hit) }); break; }
    }
  }
  const hints = envHints();
  if (hints.VULKAN_SDK && isDir(hints.VULKAN_SDK)) found.push({ kind: 'vulkan', path: hints.VULKAN_SDK });
  return found;
}

/**
 * Everything reachable from environment variables and PATH. This is the
 * authoritative "user told the OS where it is" set and wins over scanning.
 */
export function probeEnvironment() {
  const hints = envHints();
  const out = { jdks: [], gradles: [], androidSdks: [], ffmpegs: [], lwjgls: [], ideas: [], graphics: [] };

  if (hints.JAVA_HOME) {
    const jdk = probeJdk(hints.JAVA_HOME, 'env:JAVA_HOME');
    if (jdk) out.jdks.push(jdk);
  }
  if (hints.GRADLE_HOME) {
    const gradle = probeGradle(hints.GRADLE_HOME, 'env:GRADLE_HOME') || probeGradle(dirname(hints.GRADLE_HOME), 'env:GRADLE_HOME');
    if (gradle) out.gradles.push(gradle);
  }
  if (hints.ANDROID_HOME) {
    const sdk = probeAndroidSdk(hints.ANDROID_HOME, 'env:ANDROID_HOME');
    if (sdk) out.androidSdks.push(sdk);
  }
  if (hints.FFMPEG) {
    const dir = isFile(hints.FFMPEG) ? dirname(hints.FFMPEG) : hints.FFMPEG;
    const ff = probeFfmpeg(dir, 'env:FFMPEG');
    if (ff) out.ffmpegs.push(ff);
  }
  if (hints.LWJGL) {
    const lw = probeLwjgl(hints.LWJGL, 'env:LWJGL_HOME');
    if (lw) out.lwjgls.push(lw);
  }
  if (hints.IDEA_HOME) {
    const idea = probeIdea(hints.IDEA_HOME, 'env:IDEA_HOME');
    if (idea) out.ideas.push(idea);
  }

  // Commands on PATH
  const javac = whichSync('javac');
  if (javac) {
    const jdk = probeJdk(dirname(dirname(javac)), 'path:javac');
    if (jdk) out.jdks.push(jdk);
  }
  const gradle = whichSync('gradle');
  if (gradle) {
    const g = probeGradle(dirname(dirname(gradle)), 'path:gradle');
    if (g) out.gradles.push(g);
  }
  const adb = whichSync('adb');
  if (adb) {
    const sdk = probeAndroidSdk(dirname(dirname(adb)), 'path:adb');
    if (sdk) out.androidSdks.push(sdk);
  }
  const ffmpeg = whichSync('ffmpeg');
  if (ffmpeg) out.ffmpegs.push({ path: realpathSafe(ffmpeg), dir: dirname(realpathSafe(ffmpeg)), version: 'unknown', ffprobe: null, source: 'path:ffmpeg' });
  const idea = whichSync('idea') || whichSync('idea.sh') || whichSync('idea64');
  if (idea) {
    const i = probeIdea(dirname(dirname(idea)), 'path:idea');
    if (i) out.ideas.push(i);
  }

  // macOS bundle roots and Windows drive roots are where installs commonly live.
  for (const root of [...fixedDrives(), ...(isMac ? ['/Library/Java/JavaVirtualMachines'] : [])]) {
    if (!isDir(root)) continue;
    for (const entry of readDir(root)) {
      const full = join(root, entry);
      if (!isDir(full)) continue;
      const jdk = probeJdk(full, 'standard');
      if (jdk) out.jdks.push(jdk);
    }
  }

  out.graphics = probeSystemGraphics();
  return out;
}

export function dedupeBy(entries, key) {
  const map = new Map();
  for (const entry of entries) {
    const id = String(entry[key] ?? '').toLowerCase();
    if (!id) continue;
    const existing = map.get(id);
    // Prefer the entry that came from an env var / PATH over a scan hit.
    if (!existing || rank(entry) < rank(existing)) map.set(id, entry);
  }
  return [...map.values()];
}

function rank(entry) {
  const s = String(entry.source || '');
  if (s.startsWith('config')) return 0;
  if (s.startsWith('env')) return 1;
  if (s.startsWith('path')) return 2;
  if (s.startsWith('project')) return 3;
  return 5;
}
