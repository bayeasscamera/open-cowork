import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  store: {
    getServers: vi.fn(),
    getServer: vi.fn(),
    saveServer: vi.fn(),
    deleteServer: vi.fn(),
    getPresets: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({ mcpConfigStore: mocks.store }));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { registerMcpIpcHandlers } from '../src/main/ipc/mcp-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

describe('mcp IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every mcp.* channel', () => {
    registerMcpIpcHandlers({ getMcpManager: () => null, invalidateMcpServersCache: vi.fn() });
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'mcp.deleteServer',
      'mcp.getPresets',
      'mcp.getServer',
      'mcp.getServerStatus',
      'mcp.getServers',
      'mcp.getTools',
      'mcp.saveServer',
    ]);
  });

  it('mcp.getServers returns stored servers and swallows store errors', async () => {
    registerMcpIpcHandlers({ getMcpManager: () => null, invalidateMcpServersCache: vi.fn() });
    mocks.store.getServers.mockReturnValue([{ id: 'a' }]);
    expect(await invoke('mcp.getServers')).toEqual([{ id: 'a' }]);

    mocks.store.getServers.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await invoke('mcp.getServers')).toEqual([]);
  });

  it('mcp.saveServer rolls back to enabled=false when the manager update fails', async () => {
    const config = { id: 'srv', name: 'Srv', enabled: true };
    const updateServer = vi.fn().mockRejectedValue(new Error('nope'));
    const invalidate = vi.fn();
    registerMcpIpcHandlers({
      getMcpManager: () => ({ updateServer }) as never,
      invalidateMcpServersCache: invalidate,
    });

    expect(await invoke('mcp.saveServer', config)).toEqual({ success: false, error: 'nope' });
    expect(mocks.store.saveServer).toHaveBeenCalledWith({ ...config, enabled: false });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('mcp.getTools / getServerStatus return [] without a manager', async () => {
    registerMcpIpcHandlers({ getMcpManager: () => null, invalidateMcpServersCache: vi.fn() });
    expect(await invoke('mcp.getTools')).toEqual([]);
    expect(await invoke('mcp.getServerStatus')).toEqual([]);
  });
});
