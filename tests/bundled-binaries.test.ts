/**
 * Tests for bundled Node/Python/tools binary resolution in dev and packaged
 * layouts (extracted from CoworkAgentRunner).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const mocks = vi.hoisted(() => ({ existsSync: vi.fn() }));

vi.mock('fs', () => ({ existsSync: mocks.existsSync }));

import {
  getBundledNodePaths,
  resolveBundledPythonBinDir,
  resolveBundledToolsBinDir,
  resetBundledBinaryCaches,
} from '../src/main/agent/bundled-binaries';

// Mirrors the module's own `path.join(__dirname, '..', '..')` project-root lookup.
const moduleDir = fileURLToPath(new URL('../src/main/agent/', import.meta.url));
const projectRoot = path.join(moduleDir, '..', '..');
const platform = process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const isWindows = platform === 'win32';
const isMac = platform === 'darwin';
const nodeBinSuffix = isWindows ? '' : 'bin';
const resourcesPath = '/opt/open-cowork/resources';
const pythonExe = isWindows ? 'python.exe' : 'python3';

const setPackaged = (packaged: boolean): void => {
  (app as unknown as { isPackaged: boolean }).isPackaged = packaged;
};

const setResourcesPath = (value: string | undefined): void => {
  if (value === undefined) {
    delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  } else {
    (process as unknown as { resourcesPath?: string }).resourcesPath = value;
  }
};

const nodePathsFor = (root: string): { node: string; npx: string } => {
  const binDir = isWindows ? root : path.join(root, 'bin');
  return {
    node: path.join(binDir, isWindows ? 'node.exe' : 'node'),
    npx: path.join(binDir, isWindows ? 'npx.cmd' : 'npx'),
  };
};

beforeEach(() => {
  mocks.existsSync.mockReset();
  resetBundledBinaryCaches();
  setPackaged(false);
  setResourcesPath(undefined);
});

afterEach(() => {
  setResourcesPath(undefined);
});

describe('getBundledNodePaths', () => {
  it('resolves the development layout when node and npx both exist', () => {
    mocks.existsSync.mockReturnValue(true);
    const root = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);

    expect(getBundledNodePaths()).toEqual(nodePathsFor(root));
    expect(mocks.existsSync).toHaveBeenCalledWith(nodePathsFor(root).node);
  });

  it('returns null when a bundled binary is missing', () => {
    mocks.existsSync.mockImplementation((candidate: unknown) => String(candidate).includes('npx'));

    expect(getBundledNodePaths()).toBeNull();
  });

  it('returns null when neither binary exists', () => {
    mocks.existsSync.mockReturnValue(false);
    expect(getBundledNodePaths()).toBeNull();
  });

  it('memoizes the resolution across calls', () => {
    mocks.existsSync.mockReturnValue(true);

    getBundledNodePaths();
    getBundledNodePaths();
    getBundledNodePaths();

    expect(mocks.existsSync).toHaveBeenCalledTimes(2);
  });

  it('resolves the packaged layout under process.resourcesPath', () => {
    setPackaged(true);
    setResourcesPath(resourcesPath);
    mocks.existsSync.mockReturnValue(true);

    expect(getBundledNodePaths()).toEqual(nodePathsFor(path.join(resourcesPath, 'node')));
  });

  it('re-resolves once the cache is reset', () => {
    mocks.existsSync.mockReturnValue(true);
    const dev = getBundledNodePaths();

    setPackaged(true);
    setResourcesPath(resourcesPath);
    resetBundledBinaryCaches();

    const packaged = getBundledNodePaths();
    expect(dev?.node).not.toBe(packaged?.node);
    expect(packaged).toEqual(nodePathsFor(path.join(resourcesPath, 'node')));
  });
});

describe('resolveBundledPythonBinDir', () => {
  it('prefers the arch-specific development directory on macOS', () => {
    if (!isMac) return;
    const binDir = path.join(projectRoot, 'resources', 'python', `darwin-${arch}`, 'bin');
    mocks.existsSync.mockImplementation(
      (candidate: unknown) => String(candidate) === path.join(binDir, pythonExe)
    );

    expect(resolveBundledPythonBinDir()).toBe(binDir);
  });

  it('falls back to the shared development directory', () => {
    const binDir = path.join(projectRoot, 'resources', 'python', 'bin');
    mocks.existsSync.mockImplementation(
      (candidate: unknown) => String(candidate) === path.join(binDir, pythonExe)
    );

    expect(resolveBundledPythonBinDir()).toBe(binDir);
  });

  it('returns null when no python interpreter is bundled', () => {
    mocks.existsSync.mockReturnValue(false);
    expect(resolveBundledPythonBinDir()).toBeNull();
  });

  it('resolves the packaged layout under process.resourcesPath', () => {
    setPackaged(true);
    setResourcesPath(resourcesPath);
    const binDir = path.join(resourcesPath, 'python', 'bin');
    mocks.existsSync.mockImplementation(
      (candidate: unknown) => String(candidate) === path.join(binDir, pythonExe)
    );

    expect(resolveBundledPythonBinDir()).toBe(binDir);
  });
});

describe('resolveBundledToolsBinDir', () => {
  it('returns null when no tools directory exists', () => {
    mocks.existsSync.mockReturnValue(false);
    expect(resolveBundledToolsBinDir()).toBeNull();
  });

  it('returns null on non-macOS platforms even when the path exists', () => {
    if (isMac) return;
    mocks.existsSync.mockReturnValue(true);
    expect(resolveBundledToolsBinDir()).toBeNull();
  });

  it('prefers the arch-specific development directory on macOS', () => {
    if (!isMac) return;
    const binDir = path.join(projectRoot, 'resources', 'tools', `darwin-${arch}`, 'bin');
    mocks.existsSync.mockImplementation((candidate: unknown) => String(candidate) === binDir);

    expect(resolveBundledToolsBinDir()).toBe(binDir);
  });

  it('falls back to the shared tools directory on macOS', () => {
    if (!isMac) return;
    const binDir = path.join(projectRoot, 'resources', 'tools', 'bin');
    mocks.existsSync.mockImplementation((candidate: unknown) => String(candidate) === binDir);

    expect(resolveBundledToolsBinDir()).toBe(binDir);
  });

  it('resolves the packaged tools directory on macOS', () => {
    if (!isMac) return;
    setPackaged(true);
    setResourcesPath(resourcesPath);
    const binDir = path.join(resourcesPath, 'tools', `darwin-${arch}`, 'bin');
    mocks.existsSync.mockImplementation((candidate: unknown) => String(candidate) === binDir);

    expect(resolveBundledToolsBinDir()).toBe(binDir);
  });
});
