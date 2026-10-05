import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  service: {
    getOverview: vi.fn(),
    search: vi.fn(),
    read: vi.fn(),
    rebuildWorkspace: vi.fn(),
    clearWorkspace: vi.fn(),
    clearCoreMemory: vi.fn(),
    rebuildAll: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    inspectSession: vi.fn(),
    setEnabled: vi.fn(),
    personalFiles: {
      list: vi.fn(),
      read: vi.fn(),
      history: vi.fn(),
      restore: vi.fn(),
    },
  },
  store: { isConfigured: vi.fn(), getAll: vi.fn() },
  sendToRenderer: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../src/main/config/config-store', () => ({ configStore: mocks.store }));
vi.mock('../src/main/memory/personal-files-manager', () => ({
  personalFilesHandler:
    (_getWindow: unknown, fn: (input: unknown) => unknown) => (_event: unknown, input: unknown) =>
      fn(input),
}));
vi.mock('../src/main/events/renderer-sender', () => ({ sendToRenderer: mocks.sendToRenderer }));

import { registerMemoryIpcHandlers } from '../src/main/ipc/memory-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

const register = (
  options: {
    withService?: boolean;
    sessionManager?: { clearAllCachedAgentSessions: () => void } | null;
  } = {}
) => {
  const withService = options.withService !== false;
  registerMemoryIpcHandlers({
    getMemoryService: () => (withService ? (mocks.service as never) : null),
    getMainWindow: () => null,
    getSessionManager: () => (options.sessionManager ?? null) as never,
  });
};

describe('memory IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
    mocks.store.isConfigured.mockReturnValue(true);
    mocks.store.getAll.mockReturnValue({ memoryEnabled: true });
  });

  it('registers every memory.* and personalFiles.* channel', () => {
    register();
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'memory.clearCoreMemory',
      'memory.clearWorkspace',
      'memory.getOverview',
      'memory.inspectSession',
      'memory.listFiles',
      'memory.notes.add',
      'memory.notes.delete',
      'memory.notes.list',
      'memory.notes.search',
      'memory.notes.update',
      'memory.read',
      'memory.readFile',
      'memory.rebuildAll',
      'memory.rebuildWorkspace',
      'memory.search',
      'memory.setEnabled',
      'personalFiles.history',
      'personalFiles.list',
      'personalFiles.read',
      'personalFiles.restore',
    ]);
  });

  it('throws a clear error when the memory service is not initialized', async () => {
    register({ withService: false });
    await expect(invoke('memory.getOverview')).rejects.toThrow('Memory service not initialized');
    await expect(invoke('memory.listFiles')).rejects.toThrow('Memory service not initialized');
  });

  it('reads degrade to safe defaults when the service is absent', async () => {
    register({ withService: false });
    for (const channel of [
      'personalFiles.list',
      'personalFiles.read',
      'personalFiles.history',
      'personalFiles.restore',
    ]) {
      expect(await invoke(channel, { path: 'a.md' })).toEqual({
        success: false,
        error: 'unavailable',
      });
    }
  });

  it('memory.setEnabled clears cached agent sessions and pushes a config snapshot', async () => {
    const clearAllCachedAgentSessions = vi.fn();
    register({ sessionManager: { clearAllCachedAgentSessions } });
    mocks.service.setEnabled.mockReturnValue({ success: true });

    expect(await invoke('memory.setEnabled', true)).toEqual({ success: true });
    expect(mocks.service.setEnabled).toHaveBeenCalledWith(true);
    expect(clearAllCachedAgentSessions).toHaveBeenCalledTimes(1);
    expect(mocks.sendToRenderer).toHaveBeenCalledWith({
      type: 'config.status',
      payload: { isConfigured: true, config: { memoryEnabled: true } },
    });
  });
});
