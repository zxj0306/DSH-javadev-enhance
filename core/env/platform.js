/**
 * Platform abstraction: executable names, PATH lookup, standard install roots,
 * user cache directory and cheap filesystem helpers.
 *
 * Everything here must work on Windows / macOS / Linux without spawning shells
 * on the hot path; only `fixedDrives()` (Windows) shells out, and its result is
 * cached for the process lifetime.
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, delimiter, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir, platform, tmpdir } from 'node:os';

export const isWin = platform() === 'win32';
export const isMac = platform() === 'darwin';
export const isLinux = platform() === 'linux';
export const PATH_SEP = isWin ? ';' : ':';

/** Windows wants an extension, POSIX does not. */
export function exe(name) {
  return isWin && !extname(name) ? `${name}.exe` : name;
}

/** Candidate file names for a command (`gradle` -> gradle / gradle.bat / gradle.cmd). */
export function exeNames(name) {
  return isWin ? [`${name}.exe`, `${name}.bat`, `${name}.cmd`, name] : [name];
}

export function exists(p) {
  try { return existsSync(p); } catch { return false; }
}

export function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

export function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

export function readDir(p) {
  try { return readdirSync(p); } catch { return []; }
}

/** readdir with dirents; symlinks are reported as-is so callers can skip cycles. */
export function readDirEntries(p) {
  try { return readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

export function realpathSafe(p) {
  try { return realpathSync.native ? realpathSync.native(p) : realpathSync(p); } catch { return p; }
}

export function statSafe(p) {
  try { return statSync(p); } catch { return null; }
}

export function splitPathList(value) {
  if (!value) return [];
  return String(value).split(PATH_SEP).map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/** Directories from PATH, plus any extra ones. */
export function pathDirs(extra = []) {
  return [...new Set([...splitPathList(process.env.PATH || process.env.Path), ...extra])];
}

/**
 * Resolve a command against PATH (and extra dirs) without spawning.
 * @param {string} cmd
 * @param {string[]} extra
 * @returns {string|null} absolute path of the first match
 */
export function whichSync(cmd, extra = []) {
  if (!cmd || typeof cmd !== 'string') return null;
  if (exists(cmd) && isFile(cmd)) return realpathSafe(cmd);
  const names = exeNames(cmd);
  for (const dir of pathDirs(extra)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return realpathSafe(candidate);
    }
  }
  return null;
}

/**
 * Standard locations where JDKs / Gradle / Android SDK / IDEA are installed,
 * per platform. None of these are machine specific.
 */
export function standardRoots() {
  const home = homedir();
  const roots = [];
  const add = (p) => { if (p) roots.push(p); };

  if (isWin) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    for (const base of [pf, pf86]) {
      add(base);
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'JetBrains', 'Android', 'Common Files']) {
        add(join(base, vendor));
      }
    }
    add(join(localApp, 'Programs'));
    add(join(localApp, 'JetBrains'));
    add(join(localApp, 'Android'));
    add(join(localApp, 'Android', 'Sdk'));
    add(join(localApp, 'Microsoft'));
    add(join(appData, 'JetBrains'));
    add(join(home, '.jdks'));
    add(join(home, '.gradle'));
    add(join(home, '.m2'));
    add(join(home, 'scoop', 'apps'));
    add(join(home, 'scoop', 'shims'));
    add(join(home, '.sdkman', 'candidates'));
    add(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey');
    add(process.env.USERPROFILE || home);
  } else if (isMac) {
    add('/Library/Java/JavaVirtualMachines');
    add('/Library/Java');
    add('/Applications');
    add('/opt/homebrew/opt');
    add('/opt/homebrew/Cellar');
    add('/usr/local/opt');
    add('/usr/local/Cellar');
    add(join(home, 'Library', 'Java', 'JavaVirtualMachines'));
    add(join(home, 'Applications'));
    add(join(home, '.sdkman', 'candidates'));
    add(join(home, '.gradle'));
    add(join(home, 'Library', 'Android', 'sdk'));
    add(join(home, '.jdks'));
    add(home);
  } else {
    add('/usr/lib/jvm');
    add('/usr/lib64/jvm');
    add('/usr/java');
    add('/opt');
    add('/opt/java');
    add('/usr/local');
    add('/snap');
    add(join(home, '.sdkman', 'candidates'));
    add(join(home, '.gradle'));
    add(join(home, '.jdks'));
    add(join(home, 'Android', 'Sdk'));
    add(home);
  }
  return [...new Set(roots.filter((p) => typeof p === 'string' && p.length > 0))];
}

/** Windows fixed drive roots (C:\, D:\ ...). Cached; returns [] on other platforms. */
let driveCache;
export function fixedDrives() {
  if (!isWin) return [];
  if (driveCache !== undefined) return driveCache;
  driveCache = [];
  const probe = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID"], { encoding: 'utf8', timeout: 6000, windowsHide: true });
  const out = (probe.stdout || '').trim();
  if (probe.status === 0 && out) {
    for (const m of out.matchAll(/([A-Za-z]):/g)) driveCache.push(`${m[1].toUpperCase()}:\\`);
  }
  if (!driveCache.length) {
    // Fallback: conventional system drive only; never block on a disconnected mapping.
    for (const letter of ['C', 'D', 'E']) {
      if (exists(`${letter}:\\`)) driveCache.push(`${letter}:\\`);
    }
  }
  return driveCache;
}

/** Cache / data directory for this plugin, outside of any DSH installation. */
export function cacheDir(override) {
  if (override) return override;
  const home = homedir();
  if (isWin) return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'dsh-java-dev');
  if (isMac) return join(home, 'Library', 'Caches', 'dsh-java-dev');
  return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'dsh-java-dev');
}

export function tmpDir() {
  return tmpdir();
}

/** Environment variables that hint at tool locations, used before filesystem scans. */
export function envHints() {
  const e = process.env;
  return {
    JAVA_HOME: e.JAVA_HOME || e.JDK_HOME || null,
    GRADLE_HOME: e.GRADLE_HOME || null,
    ANDROID_HOME: e.ANDROID_HOME || e.ANDROID_SDK_ROOT || null,
    ANDROID_NDK_HOME: e.ANDROID_NDK_HOME || e.ANDROID_NDK_ROOT || null,
    FFMPEG: e.FFMPEG_PATH || e.FFMPEG_HOME || null,
    LWJGL: e.LWJGL_HOME || null,
    IDEA_HOME: e.IDEA_HOME || null,
    VULKAN_SDK: e.VULKAN_SDK || null,
    DSH_TOOL_ROOTS: e.DSH_TOOL_ROOTS || null,
    EXTRA_ROOTS: e.JAVA_DEV_TOOL_ROOTS || null
  };
}

/** Roots listed in `DSH_TOOL_ROOTS` / `JAVA_DEV_TOOL_ROOTS` (path-separator separated). */
export function envToolRoots() {
  const hints = envHints();
  return [...splitPathList(hints.DSH_TOOL_ROOTS), ...splitPathList(hints.EXTRA_ROOTS)];
}
