/**
 * Project-aware selection: read what the project itself declares (Gradle
 * toolchain, `org.gradle.java.home`, `local.properties`, Maven compiler
 * settings, `.idea/misc.xml`, `.sdkmanrc`) and pick the best matching tool from
 * the discovered set.
 */

import { join } from 'node:path';
import { isDir, isFile, readText, readDir, realpathSafe } from './platform.js';

const LTS = ['25', '21', '17', '11', '8'];

/** Major version of a JDK version string (`21.0.2+13`, `1.8.0_301`). */
export function majorOf(version) {
  const v = String(version || '');
  const m = v.match(/^1\.(\d+)/);
  if (m) return Number(m[1]);
  const n = v.match(/^(\d+)/);
  return n ? Number(n[1]) : 0;
}

export function compareVersions(a = '', b = '') {
  const pa = String(a).split(/[.+_-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+_-]/).map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Java-properties value unescaping (`D\:\\sdk` -> `D:\sdk`). */
export function unescapeProperty(value) {
  return String(value || '')
    .trim()
    .replace(/\\:/g, ':')
    .replace(/\\\\/g, '\\')
    .replace(/\\=/g, '=')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function propsValue(text, key) {
  if (!text) return null;
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]\\s*(.+)$`, 'm');
  const m = text.match(re);
  return m ? unescapeProperty(m[1].replace(/#.*$/, '')) : null;
}

/**
 * Read everything the project declares about its toolchain.
 * @param {string} projectDir
 */
export function readProjectHints(projectDir) {
  const hints = {
    projectDir,
    javaHome: null,
    javaMajor: null,
    sdkDir: null,
    ndkDir: null,
    gradleVersion: null,
    hasWrapper: false,
    buildSystem: null,
    sources: []
  };
  if (!projectDir) return hints;

  const localProps = readText(join(projectDir, 'local.properties'));
  if (localProps) {
    const sdk = propsValue(localProps, 'sdk.dir');
    if (sdk) { hints.sdkDir = sdk; hints.sources.push('local.properties:sdk.dir'); }
    const ndk = propsValue(localProps, 'ndk.dir');
    if (ndk) hints.ndkDir = ndk;
  }

  const gradleProps = readText(join(projectDir, 'gradle.properties'));
  if (gradleProps) {
    const home = propsValue(gradleProps, 'org.gradle.java.home');
    if (home) { hints.javaHome = home; hints.sources.push('gradle.properties:org.gradle.java.home'); }
  }

  const wrapper = join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (isFile(wrapper)) {
    hints.hasWrapper = true;
    const props = readText(wrapper);
    const url = props && props.match(/distributionUrl=.*?gradle-([\d.]+(?:-[a-z0-9]+)?)-(?:bin|all)\.zip/i);
    if (url) hints.gradleVersion = url[1];
  }
  if (isFile(join(projectDir, 'gradlew')) || isFile(join(projectDir, 'gradlew.bat'))) hints.hasWrapper = true;

  const gradleBuild = readText(join(projectDir, 'build.gradle')) || readText(join(projectDir, 'build.gradle.kts')) || '';
  if (gradleBuild) {
    hints.buildSystem = hints.buildSystem || 'gradle';
    const toolchain = gradleBuild.match(/languageVersion\s*=\s*(?:JavaLanguageVersion\.)?of\(\s*(\d+)/)
      || gradleBuild.match(/sourceCompatibility\s*=?\s*(?:JavaVersion\.)?(?:VERSION_)?(\d+)/)
      || gradleBuild.match(/targetCompatibility\s*=?\s*(?:JavaVersion\.)?(?:VERSION_)?(\d+)/);
    if (toolchain) { hints.javaMajor = Number(toolchain[1]); hints.sources.push('build.gradle:toolchain'); }
  }

  const pom = readText(join(projectDir, 'pom.xml'));
  if (pom) {
    hints.buildSystem = hints.buildSystem || 'maven';
    const m = pom.match(/<maven\.compiler\.(?:source|release|target)>\s*([\d.]+)\s*</)
      || pom.match(/<java\.version>\s*([\d.]+)\s*</)
      || pom.match(/<release>\s*([\d.]+)\s*</);
    if (m && !hints.javaMajor) { hints.javaMajor = majorOf(m[1]); hints.sources.push('pom.xml:compiler'); }
  }

  const sdkmanrc = readText(join(projectDir, '.sdkmanrc'));
  if (sdkmanrc) {
    const m = sdkmanrc.match(/^java\s*=\s*(\S+)/m);
    if (m) {
      const major = m[1].match(/^(\d+)/);
      if (major && !hints.javaMajor) hints.javaMajor = Number(major[1]);
    }
  }

  // A `.jdks`/`.gradle` local dir or an IDE JDK name
  const misc = readText(join(projectDir, '.idea', 'misc.xml'));
  if (misc) {
    const m = misc.match(/project-jdk-name="([^"]+)"/);
    if (m) {
      const major = m[1].match(/(\d+)/);
      if (major && !hints.javaMajor) { hints.javaMajor = Number(major[1]); hints.sources.push('.idea/misc.xml:project-jdk'); }
    }
  }

  if (!hints.buildSystem) {
    if (isFile(join(projectDir, 'settings.gradle')) || isFile(join(projectDir, 'settings.gradle.kts'))) hints.buildSystem = 'gradle';
    else if (isFile(join(projectDir, 'pom.xml'))) hints.buildSystem = 'maven';
    else if (isDir(join(projectDir, 'src'))) hints.buildSystem = 'plain';
  }
  return hints;
}

function jdkFromHome(home, source) {
  if (!home) return null;
  for (const name of ['javac.exe', 'javac']) {
    const candidate = join(home, 'bin', name);
    if (isFile(candidate)) {
      const release = readText(join(home, 'release'));
      const version = (release && release.match(/JAVA_VERSION="([^"]+)"/)?.[1]) || null;
      return { path: realpathSafe(candidate), javaHome: realpathSafe(home), version: version || 'unknown', isGraal: /graal/i.test(home), source };
    }
  }
  return null;
}

/** Pick the JDK that best matches the project. */
function pickJdk(jdks, hints) {
  if (!jdks.length) return null;
  const byHome = hints.javaHome ? jdkFromHome(hints.javaHome, 'project:org.gradle.java.home') : null;
  if (byHome) return byHome;

  const complete = jdks.filter((j) => !j.partial);
  const usable = complete.length ? complete : jdks;
  const exact = hints.javaMajor ? usable.filter((j) => majorOf(j.version) === hints.javaMajor) : [];
  const pool = exact.length ? exact : usable;
  const sorted = [...pool].sort((a, b) => compareVersions(b.version, a.version));
  // Prefer LTS majors over exotic versions when the project does not pin one.
  if (!hints.javaMajor) {
    for (const lts of LTS) {
      const hit = sorted.find((j) => majorOf(j.version) === Number(lts));
      if (hit) return hit;
    }
  }
  return sorted[0];
}

function pickGradle(gradles, hints) {
  const wrapper = hints.projectDir && hints.hasWrapper
    ? ['gradlew.bat', 'gradlew'].map((n) => join(hints.projectDir, n)).find((p) => isFile(p))
    : null;
  if (wrapper) return { path: wrapper, version: hints.gradleVersion || 'wrapper', gradleHome: hints.projectDir, source: 'project:wrapper' };
  const sorted = [...gradles].sort((a, b) => compareVersions(b.version, a.version));
  return sorted[0] || null;
}

/**
 * Combine discovered tools with project hints.
 * @param {object} tools result of scanTools()
 * @param {object} hints result of readProjectHints()
 */
export function selectTools(tools, hints) {
  const jdk = pickJdk(tools.jdks || [], hints);

  let sdk = null;
  if (hints.sdkDir && isDir(hints.sdkDir)) {
    const adb = ['platform-tools/adb.exe', 'platform-tools/adb'].map((p) => join(hints.sdkDir, p)).find((p) => isFile(p)) || null;
    sdk = {
      path: realpathSafe(hints.sdkDir),
      adb,
      platforms: readDir(join(hints.sdkDir, 'platforms')).filter((d) => /^android-/.test(d)).sort(),
      buildTools: readDir(join(hints.sdkDir, 'build-tools')).filter((d) => /^\d/.test(d)).sort(),
      ndk: hints.ndkDir || null,
      source: 'project:local.properties'
    };
  }
  if (!sdk) sdk = (tools.androidSdks || [])[0] || null;

  return {
    jdk: jdk || { missing: true },
    gradle: pickGradle(tools.gradles || [], hints) || { missing: true },
    androidSdk: sdk || { missing: true },
    ffmpeg: (tools.ffmpegs || [])[0] || { missing: true },
    opengl: (tools.lwjgls || []).length ? tools.lwjgls.map((l) => ({ project: l.displayName, libDir: l.libDir, lwjgl: l.lwjgl, natives: l.natives, version: l.version })) : (tools.graphics || []).length ? tools.graphics.map((g) => ({ [g.kind]: g.path })) : { missing: true },
    formatter: (tools.ideas || []).find((i) => i.formatter) ? {
      version: (tools.ideas.find((i) => i.formatter) || {}).version,
      idea: tools.ideas.find((i) => i.formatter).formatter,
      home: tools.ideas.find((i) => i.formatter).path
    } : { missing: true }
  };
}

