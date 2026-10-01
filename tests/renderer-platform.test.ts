import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArch, getPlatform, isLinux, isMac, isWindows } from '../src/renderer/utils/platform';

function stubBridge(electronAPI: unknown | undefined): void {
  vi.stubGlobal('window', electronAPI === undefined ? {} : { electronAPI });
}

afterEach(() => vi.unstubAllGlobals());

describe('renderer platform helpers', () => {
  it('reads the platform and arch exposed by the preload', () => {
    stubBridge({ platform: 'darwin', arch: 'arm64' });

    expect(getPlatform()).toBe('darwin');
    expect(getArch()).toBe('arm64');
    expect(isMac()).toBe(true);
    expect(isWindows()).toBe(false);
  });

  it('identifies Windows and excludes it from isMac/isLinux', () => {
    stubBridge({ platform: 'win32', arch: 'x64' });

    expect(isWindows()).toBe(true);
    expect(isMac()).toBe(false);
    expect(isLinux()).toBe(false);
  });

  it('identifies Linux', () => {
    stubBridge({ platform: 'linux', arch: 'x64' });

    expect(isLinux()).toBe(true);
    expect(isMac()).toBe(false);
    expect(isWindows()).toBe(false);
  });

  // The renderer boots in a plain browser tab during development and in every
  // renderer test, so a missing bridge must degrade to "unknown", never throw.
  it('degrades to unknown when the preload bridge is absent', () => {
    stubBridge(undefined);

    expect(getPlatform()).toBeNull();
    expect(getArch()).toBeNull();
    expect(isMac()).toBe(false);
    expect(isWindows()).toBe(false);
    expect(isLinux()).toBe(false);
  });

  it('does not throw when there is no window global at all', () => {
    vi.stubGlobal('window', undefined);

    expect(() => isMac()).not.toThrow();
    expect(isMac()).toBe(false);
    expect(getArch()).toBeNull();
  });

  it('reads live values instead of caching at module load', () => {
    stubBridge({ platform: 'darwin', arch: 'arm64' });
    expect(isMac()).toBe(true);

    stubBridge({ platform: 'win32', arch: 'x64' });
    expect(isMac()).toBe(false);
    expect(isWindows()).toBe(true);
  });
});
