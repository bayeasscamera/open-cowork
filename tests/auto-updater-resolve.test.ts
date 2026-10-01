/**
 * The production boot silently disabled updates: under the vite bundle,
 * `import('electron-updater')` yields a namespace WITHOUT the `autoUpdater`
 * getter (CJS lazy export, invisible to ESM interop) — only `default`
 * carries it. The resolver must accept both shapes and reject the rest.
 */
import { describe, expect, it } from 'vitest';

import { resolveAutoUpdater } from '../src/main/utils/updater-resolve';

const fakeUpdater = { checkForUpdatesAndNotify: async () => undefined };

describe('resolveAutoUpdater', () => {
  it('accepts the direct named shape (dev / require interop)', () => {
    expect(resolveAutoUpdater({ autoUpdater: fakeUpdater })).toBe(fakeUpdater);
  });

  it('accepts the default-wrapped shape (production bundle interop)', () => {
    expect(resolveAutoUpdater({ default: { autoUpdater: fakeUpdater } })).toBe(fakeUpdater);
  });

  it('rejects namespaces without a usable updater', () => {
    expect(resolveAutoUpdater({})).toBeNull();
    expect(resolveAutoUpdater({ default: {} })).toBeNull();
    expect(resolveAutoUpdater(null)).toBeNull();
    expect(resolveAutoUpdater(undefined)).toBeNull();
    expect(resolveAutoUpdater('electron-updater')).toBeNull();
  });

  it('rejects an updater without the check method', () => {
    expect(resolveAutoUpdater({ autoUpdater: {} })).toBeNull();
    expect(resolveAutoUpdater({ default: { autoUpdater: { check: 1 } } })).toBeNull();
  });

  it('prefers the direct binding when both exist', () => {
    const direct = { checkForUpdatesAndNotify: async () => 'direct' };
    const wrapped = { checkForUpdatesAndNotify: async () => 'wrapped' };
    expect(resolveAutoUpdater({ autoUpdater: direct, default: { autoUpdater: wrapped } })).toBe(
      direct
    );
  });
});
