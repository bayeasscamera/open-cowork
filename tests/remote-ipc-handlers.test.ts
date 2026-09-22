import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  manager: {
    getStatus: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    updateGatewayConfig: vi.fn(),
    updateFeishuConfig: vi.fn(),
    getPairedUsers: vi.fn(),
    getPendingPairings: vi.fn(),
    approvePairing: vi.fn(),
    revokePairing: vi.fn(),
    rejectPairing: vi.fn(),
    getRemoteSessions: vi.fn(),
    clearRemoteSession: vi.fn(),
    getTunnelStatus: vi.fn(),
    getFeishuWebhookUrl: vi.fn(),
    restart: vi.fn(),
  },
  config: { getAll: vi.fn(), setEnabled: vi.fn() },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));
vi.mock('../src/main/remote/remote-manager', () => ({ remoteManager: mocks.manager }));
vi.mock('../src/main/remote/remote-config-store', () => ({ remoteConfigStore: mocks.config }));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { registerRemoteIpcHandlers } from '../src/main/ipc/remote-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

describe('remote IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every remote.* channel', () => {
    registerRemoteIpcHandlers();
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'remote.approvePairing',
      'remote.clearRemoteSession',
      'remote.getConfig',
      'remote.getPairedUsers',
      'remote.getPendingPairings',
      'remote.getRemoteSessions',
      'remote.getStatus',
      'remote.getTunnelStatus',
      'remote.getWebhookUrl',
      'remote.rejectPairing',
      'remote.restart',
      'remote.revokePairing',
      'remote.setEnabled',
      'remote.updateFeishuConfig',
      'remote.updateGatewayConfig',
    ]);
  });

  it('remote.setEnabled persists the flag then starts or stops the manager', async () => {
    registerRemoteIpcHandlers();
    mocks.manager.start.mockResolvedValue(undefined);
    mocks.manager.stop.mockResolvedValue(undefined);

    expect(await invoke('remote.setEnabled', true)).toEqual({ success: true });
    expect(mocks.config.setEnabled).toHaveBeenCalledWith(true);
    expect(mocks.manager.start).toHaveBeenCalledTimes(1);
    expect(mocks.manager.stop).not.toHaveBeenCalled();

    expect(await invoke('remote.setEnabled', false)).toEqual({ success: true });
    expect(mocks.manager.stop).toHaveBeenCalledTimes(1);
  });

  it('remote.setEnabled reports a failed start instead of throwing', async () => {
    registerRemoteIpcHandlers();
    mocks.manager.start.mockRejectedValue(new Error('port busy'));
    expect(await invoke('remote.setEnabled', true)).toEqual({
      success: false,
      error: 'port busy',
    });
  });

  it('read-only channels degrade to safe defaults on failure', async () => {
    registerRemoteIpcHandlers();
    mocks.manager.getStatus.mockImplementation(() => {
      throw new Error('boom');
    });
    mocks.manager.getPairedUsers.mockImplementation(() => {
      throw new Error('boom');
    });
    mocks.manager.getFeishuWebhookUrl.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(await invoke('remote.getStatus')).toEqual({
      running: false,
      channels: [],
      activeSessions: 0,
      pendingPairings: 0,
    });
    expect(await invoke('remote.getPairedUsers')).toEqual([]);
    expect(await invoke('remote.getWebhookUrl')).toBeNull();
  });
});
