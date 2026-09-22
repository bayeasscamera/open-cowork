/**
 * @module main/agent/skills-paths
 *
 * Skill directory discovery and synchronization helpers extracted from
 * CoworkAgentRunner: built-in/runtime/user skills roots, configured global
 * path fallback, and symlink-or-copy synchronization.
 */

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { configStore } from '../config/config-store';
import { log, logWarn } from '../utils/logger';
import { getBundledNodePaths, resolveBundledPythonBinDir } from './bundled-binaries';

export function getBundledPathHints(): string {
  if (!app.isPackaged) return '';

  const hints: string[] = [];

  const nodePaths = getBundledNodePaths();
  if (nodePaths) {
    hints.push(`- node: ${nodePaths.node}`);
    hints.push(`- npx: ${nodePaths.npx}`);
  }

  const pythonBinDir = resolveBundledPythonBinDir();
  if (pythonBinDir) {
    const pythonExe = process.platform === 'win32' ? 'python.exe' : 'python3';
    const pipExe = process.platform === 'win32' ? 'pip.exe' : 'pip3';
    hints.push(`- python3: ${path.join(pythonBinDir, pythonExe)}`);
    if (fs.existsSync(path.join(pythonBinDir, pipExe))) {
      hints.push(`- pip3: ${path.join(pythonBinDir, pipExe)}`);
    }
  }

  if (hints.length === 0) return '';

  return `<bundled_executables>
This application bundles its own executables. When executing commands, prefer these absolute paths:
${hints.join('\n')}
</bundled_executables>`;
}

/** Fallback skill path resolution when SkillsAdapter is not provided. */
export function legacySkillPaths(): string[] {
  const paths: string[] = [];
  const builtin = getBuiltinSkillsPath();
  if (builtin && fs.existsSync(builtin)) paths.push(builtin);
  const global = getConfiguredGlobalSkillsDir();
  if (global && fs.existsSync(global)) paths.push(global);
  return paths;
}

/**
 * Get the built-in skills directory (shipped with the app)
 */
export function getBuiltinSkillsPath(): string {
  // In development, skills are in the project's .claude/skills directory
  // In production, they're extracted via extraResources to resources/skills
  const appPath = app.getAppPath();
  const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');

  const possiblePaths = [
    // Development: relative to this file
    path.join(__dirname, '..', '..', '..', '.claude', 'skills'),
    // Production: extraResources extracts .claude/skills → resources/skills
    // This is the preferred production path (real directory, no asar issues)
    path.join(process.resourcesPath || '', 'skills'),
    // Legacy: in app.asar.unpacked (for older builds with asarUnpack)
    ...(physicalDirExists(path.join(unpackedPath, '.claude', 'skills'))
      ? [path.join(unpackedPath, '.claude', 'skills')]
      : []),
    // Last resort: read from inside the asar archive (Electron intercepts this)
    path.join(appPath, '.claude', 'skills'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      log('[CoworkAgentRunner] Found built-in skills at:', p);
      return p;
    }
  }

  logWarn('[CoworkAgentRunner] No built-in skills directory found');
  return '';
}

/**
 * Check if a directory physically exists on disk, bypassing Electron's
 * asar interception.
 */
function physicalDirExists(dirPath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const originalFs = require('original-fs') as typeof import('fs');
    return originalFs.existsSync(dirPath) && originalFs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function getAppAgentDir(): string {
  return path.join(app.getPath('userData'), 'claude');
}

export function getRuntimeSkillsDir(): string {
  return path.join(getAppAgentDir(), 'skills');
}

export function getConfiguredGlobalSkillsDir(): string {
  const configuredPath = (configStore.get('globalSkillsPath') || '').trim();
  if (!configuredPath) {
    return getRuntimeSkillsDir();
  }

  const resolvedPath = path.resolve(configuredPath);
  try {
    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true });
    }
    if (fs.statSync(resolvedPath).isDirectory()) {
      return resolvedPath;
    }
    logWarn(
      '[CoworkAgentRunner] Configured skills path is not a directory, fallback to runtime path:',
      resolvedPath
    );
  } catch (error) {
    logWarn(
      '[CoworkAgentRunner] Configured skills path is unavailable, fallback to runtime path:',
      resolvedPath,
      error
    );
  }

  return getRuntimeSkillsDir();
}

function getUserSkillsDir(): string {
  return path.join(app.getPath('home'), '.claude', 'skills');
}

export function syncUserSkillsToAppDir(appSkillsDir: string): void {
  const userSkillsDir = getUserSkillsDir();
  if (!fs.existsSync(userSkillsDir)) {
    return;
  }

  const entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourcePath = path.join(userSkillsDir, entry.name);
    const targetPath = path.join(appSkillsDir, entry.name);

    if (fs.existsSync(targetPath)) {
      try {
        const stat = fs.lstatSync(targetPath);
        if (!stat.isSymbolicLink()) {
          continue;
        }
        fs.unlinkSync(targetPath);
      } catch {
        continue;
      }
    }

    try {
      fs.symlinkSync(sourcePath, targetPath, 'dir');
    } catch (err) {
      try {
        copyDirectorySync(sourcePath, targetPath);
      } catch (copyErr) {
        logWarn('[CoworkAgentRunner] Failed to import user skill:', entry.name, copyErr);
      }
    }
  }
}

export function syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir: string): void {
  const configuredSkillsDir = getConfiguredGlobalSkillsDir();
  if (configuredSkillsDir === runtimeSkillsDir) {
    return;
  }
  if (!fs.existsSync(configuredSkillsDir) || !fs.statSync(configuredSkillsDir).isDirectory()) {
    return;
  }

  const entries = fs.readdirSync(configuredSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourcePath = path.join(configuredSkillsDir, entry.name);
    const targetPath = path.join(runtimeSkillsDir, entry.name);
    try {
      if (fs.existsSync(targetPath)) {
        // Use lstatSync so we don't follow symlinks — check the entry itself
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(targetPath);
        } else {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
      }
      fs.symlinkSync(sourcePath, targetPath, 'dir');
    } catch (err) {
      try {
        copyDirectorySync(sourcePath, targetPath);
      } catch (copyErr) {
        logWarn('[CoworkAgentRunner] Failed to sync configured skill:', entry.name, copyErr);
      }
    }
  }
}

export function copyDirectorySync(source: string, target: string): void {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const entries = fs.readdirSync(source);
  for (const entry of entries) {
    const sourcePath = path.join(source, entry);
    const targetPath = path.join(target, entry);
    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      copyDirectorySync(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}
