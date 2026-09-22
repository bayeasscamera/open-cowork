import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  adapter: { mode: 'native', initialized: true },
  wsl: { checkWSLStatus: vi.fn(), installNodeInWSL: vi.fn(), installPythonInWSL: vi.fn() },
  lima: {
    checkLimaStatus: vi.fn(),
    startLimaInstance: vi.fn(),
    stopLimaInstance: vi.fn(),
    installNodeInLima: vi.fn(),
    installPythonInLima: vi.fn(),
  },
  bootstrap: { setProgressCallback: vi.fn(), reset: vi.fn(), bootstrap: vi.fn() },
  sendToRenderer: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));
vi.mock('../src/main/sandbox/sandbox-adapter', () => ({
  getSandboxAdapter: () => mocks.adapter,
}));
vi.mock('../src/main/sandbox/wsl-bridge', () => ({ WSLBridge: mocks.wsl }));
vi.mock('../src/main/sandbox/lima-bridge', () => ({ LimaBridge: mocks.lima }));
vi.mock('../src/main/sandbox/sandbox-bootstrap', () => ({
  getSandboxBootstrap: () => mocks.bootstrap,
}));
vi.mock('../src/main/events/renderer-sender', () => ({
  sendToRenderer: mocks.sendToRenderer,
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { registerSandboxIpcHandlers } from '../src/main/ipc/sandbox-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

describe('sandbox IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every sandbox.* channel', () => {
    registerSandboxIpcHandlers();
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'sandbox.checkLima',
      'sandbox.checkWSL',
      'sandbox.getStatus',
      'sandbox.installNodeInLima',
      'sandbox.installNodeInWSL',
      'sandbox.installPythonInLima',
      'sandbox.installPythonInWSL',
      'sandbox.retryLimaSetup',
      'sandbox.retrySetup',
      'sandbox.startLimaInstance',
      'sandbox.stopLimaInstance',
    ]);
  });

  it('delegates WSL and Lima provisioning to the bridges', async () => {
    registerSandboxIpcHandlers();
    mocks.wsl.checkWSLStatus.mockResolvedValue({ available: true });
    mocks.wsl.installNodeInWSL.mockResolvedValue(true);
    mocks.lima.startLimaInstance.mockResolvedValue(true);
    mocks.lima.installPythonInLima.mockResolvedValue(true);

    expect(await invoke('sandbox.checkWSL')).toEqual({ available: true });
    expect(await invoke('sandbox.installNodeInWSL', 'Ubuntu')).toBe(true);
    expect(await invoke('sandbox.startLimaInstance')).toBe(true);
    expect(await invoke('sandbox.installPythonInLima')).toBe(true);
  });

  it('install handlers degrade to false instead of throwing', async () => {
    registerSandboxIpcHandlers();
    mocks.wsl.installNodeInWSL.mockRejectedValue(new Error('boom'));
    mocks.lima.installNodeInLima.mockRejectedValue(new Error('boom'));
    expect(await invoke('sandbox.installNodeInWSL', 'Ubuntu')).toBe(false);
    expect(await invoke('sandbox.installNodeInLima')).toBe(false);
  });

  it('retrySetup resets the bootstrap and reports the result', async () => {
    registerSandboxIpcHandlers();
    mocks.bootstrap.bootstrap.mockResolvedValue({ error: undefined });
    // The handler forwards bootstrap progress to the renderer.
    mocks.bootstrap.setProgressCallback.mockImplementation((cb: (progress: unknown) => void) =>
      cb({ step: 'pull-image' })
    );
    expect(await invoke('sandbox.retrySetup')).toEqual({
      success: true,
      result: { error: undefined },
      error: undefined,
    });
    expect(mocks.bootstrap.reset).toHaveBeenCalledTimes(1);
    expect(mocks.sendToRenderer).toHaveBeenCalledWith({
      type: 'sandbox.progress',
      payload: { step: 'pull-image' },
    });
  });

  it('retryLimaSetup refuses to run on non-macOS platforms', async () => {
    registerSandboxIpcHandlers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await invoke('sandbox.retryLimaSetup')).toEqual({
        success: false,
        error: 'Lima is only available on macOS',
      });
      expect(mocks.bootstrap.bootstrap).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
