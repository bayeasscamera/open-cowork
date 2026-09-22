/**
 * @module main/agent/bundled-binaries
 *
 * Resolution of the Node, Python and tools binaries bundled with Open Cowork.
 * Extracted from CoworkAgentRunner so the dev/packaged layout logic stays
 * testable in isolation.
 */

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

// Bundled node/npx paths never change at runtime — resolve once.
let cachedBundledNodePaths: { node: string; npx: string } | null | undefined = undefined;

/** Reset the memoized Node/npx lookup (used by tests and environment switches). */
export function resetBundledBinaryCaches(): void {
  cachedBundledNodePaths = undefined;
}

export function getBundledNodePaths(): { node: string; npx: string } | null {
  if (cachedBundledNodePaths !== undefined) {
    return cachedBundledNodePaths;
  }
  const platform = process.platform;
  const arch = process.arch;
  let resourcesPath: string;
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    resourcesPath = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);
  } else {
    resourcesPath = path.join(process.resourcesPath, 'node');
  }
  const binDir = platform === 'win32' ? resourcesPath : path.join(resourcesPath, 'bin');
  const nodePath = path.join(binDir, platform === 'win32' ? 'node.exe' : 'node');
  const npxPath = path.join(binDir, platform === 'win32' ? 'npx.cmd' : 'npx');
  cachedBundledNodePaths =
    fs.existsSync(nodePath) && fs.existsSync(npxPath) ? { node: nodePath, npx: npxPath } : null;
  return cachedBundledNodePaths;
}

/**
 * Resolve bundled Python bin directory path (if available).
 * Checks packaged and dev layouts, returns the bin dir containing python3.
 */
export function resolveBundledPythonBinDir(): string | null {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    if (platform === 'darwin') {
      candidates.push(path.join(projectRoot, 'resources', 'python', `darwin-${arch}`, 'bin'));
    }
    candidates.push(path.join(projectRoot, 'resources', 'python', 'bin'));
  } else {
    // Packaged layout: Resources/python/bin/python3
    candidates.push(path.join(process.resourcesPath, 'python', 'bin'));
  }

  const pythonExe = platform === 'win32' ? 'python.exe' : 'python3';
  for (const binDir of candidates) {
    if (fs.existsSync(path.join(binDir, pythonExe))) return binDir;
  }
  return null;
}

/**
 * Resolve bundled tools directory (cliclick etc., macOS only).
 */
export function resolveBundledToolsBinDir(): string | null {
  if (process.platform !== 'darwin') return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    candidates.push(path.join(projectRoot, 'resources', 'tools', `darwin-${arch}`, 'bin'));
    candidates.push(path.join(projectRoot, 'resources', 'tools', 'bin'));
  } else {
    candidates.push(path.join(process.resourcesPath, 'tools', `darwin-${arch}`, 'bin'));
    candidates.push(path.join(process.resourcesPath, 'tools', 'bin'));
  }

  for (const binDir of candidates) {
    if (fs.existsSync(binDir)) return binDir;
  }
  return null;
}
