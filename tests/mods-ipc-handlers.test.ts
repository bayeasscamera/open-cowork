import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  registry: { list: vi.fn(), setEnabled: vi.fn() },
  diffCollector: { summary: vi.fn() },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));
vi.mock('../src/main/mods/mods-runtime', () => ({
  getModsRegistry: () => mocks.registry,
}));
vi.mock('../src/main/mods/builtin-mods', () => ({
  getDiffCollector: () => mocks.diffCollector,
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { registerModsIpcHandlers } from '../src/main/ipc/mods-handlers';

const invoke = (channel: string, ...args: unknown[]): unknown => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

describe('mods and diff IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers mods.list, mods.setEnabled and diff.getSessionFiles', () => {
    registerModsIpcHandlers();
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'diff.getSessionFiles',
      'mods.list',
      'mods.setEnabled',
    ]);
  });

  it('mods.list returns the registry contents and degrades on failure', () => {
    registerModsIpcHandlers();
    mocks.registry.list.mockReturnValue([{ id: 'a' }]);
    expect(invoke('mods.list')).toEqual({ success: true, mods: [{ id: 'a' }] });

    mocks.registry.list.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(invoke('mods.list')).toEqual({ success: false, mods: [] });
  });

  it('mods.setEnabled rejects non-boolean input without touching the registry', () => {
    registerModsIpcHandlers();
    expect(invoke('mods.setEnabled', 'a', 'yes')).toEqual({
      success: false,
      error: 'invalid_input',
    });
    expect(mocks.registry.setEnabled).not.toHaveBeenCalled();

    expect(invoke('mods.setEnabled', 'a', true)).toEqual({ success: true });
    expect(mocks.registry.setEnabled).toHaveBeenCalledWith('a', true);
  });

  it('diff.getSessionFiles rejects an empty session id and returns the summary otherwise', () => {
    registerModsIpcHandlers();
    expect(invoke('diff.getSessionFiles', '   ')).toEqual({ success: false, files: [] });
    expect(mocks.diffCollector.summary).not.toHaveBeenCalled();

    mocks.diffCollector.summary.mockReturnValue([{ path: 'a.ts' }]);
    expect(invoke('diff.getSessionFiles', 's1')).toEqual({
      success: true,
      files: [{ path: 'a.ts' }],
    });
  });
});
