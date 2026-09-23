import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  store: {
    getAll: vi.fn(),
    set: vi.fn(),
    applyToEnv: vi.fn(),
    isConfigured: vi.fn(),
    hasAnyUsableCredentials: vi.fn(),
    update: vi.fn(),
    createSet: vi.fn(),
    renameSet: vi.fn(),
    deleteSet: vi.fn(),
    switchSet: vi.fn(),
  },
  presets: vi.fn(),
  apiTest: vi.fn(),
  listOllamaModels: vi.fn(),
  exportOnConfigChange: vi.fn(),
  sendToRenderer: vi.fn(),
  collectHealthReport: vi.fn(),
  projectStoreGet: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

vi.mock('../src/main/config/config-store', () => ({
  configStore: mocks.store,
  getPiAiModelPresets: mocks.presets,
}));
vi.mock('../src/main/config/config-file-watcher', () => ({
  exportOnConfigChange: mocks.exportOnConfigChange,
}));
vi.mock('../src/main/config/config-test-routing', () => ({ runConfigApiTest: mocks.apiTest }));
vi.mock('../src/main/config/ollama-api', () => ({ listOllamaModels: mocks.listOllamaModels }));
vi.mock('../src/main/events/renderer-sender', () => ({ sendToRenderer: mocks.sendToRenderer }));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../src/main/utils/health-report-collector', () => ({
  collectHealthReport: mocks.collectHealthReport,
}));
vi.mock('../src/main/projects/project-store', () => ({
  getSharedProjectStore: () => ({ get: mocks.projectStoreGet }),
}));

import { registerConfigIpcHandlers } from '../src/main/ipc/config-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

const register = (
  overrides: Partial<{
    sessionManager: { reloadConfig: () => void; reloadSandbox: () => Promise<void> } | null;
    applyBackgroundAccessSetting: (enabled: boolean) => void;
  }> = {}
) => {
  const applyBackgroundAccessSetting = overrides.applyBackgroundAccessSetting ?? vi.fn();
  registerConfigIpcHandlers({
    getSessionManager: () => overrides.sessionManager ?? null,
    applyBackgroundAccessSetting,
  });
  return { applyBackgroundAccessSetting };
};

describe('config IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
    mocks.store.getAll.mockReturnValue({ provider: 'anthropic' });
    mocks.store.isConfigured.mockReturnValue(true);
    mocks.store.hasAnyUsableCredentials.mockReturnValue(true);
  });

  it('registers every config.* channel', () => {
    register();
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'config.createSet',
      'config.deleteSet',
      'config.diagnose',
      'config.discover-local',
      'config.get',
      'config.getPresets',
      'config.isConfigured',
      'config.listModels',
      'config.renameSet',
      'config.save',
      'config.switchSet',
      'config.test',
      'diagnostics.report',
    ]);
  });

  it('diagnostics.report delegates to the health collector', async () => {
    mocks.collectHealthReport.mockReturnValue({ status: 'ok', checks: [], generatedAt: 1 });
    register();
    expect(await invoke('diagnostics.report', { sessionId: null })).toEqual({
      status: 'ok',
      checks: [],
      generatedAt: 1,
    });
    expect(mocks.collectHealthReport).toHaveBeenCalledWith({ session: null, project: null });
  });

  it('config.get returns the store snapshot and swallows store errors', async () => {
    register();
    expect(await invoke('config.get')).toEqual({ provider: 'anthropic' });

    mocks.store.getAll.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await invoke('config.get')).toEqual({});
  });

  it('config.save persists, reloads the runtime and applies the tray setting', async () => {
    const reloadConfig = vi.fn();
    const reloadSandbox = vi.fn().mockResolvedValue(undefined);
    const { applyBackgroundAccessSetting } = register({
      sessionManager: { reloadConfig, reloadSandbox },
    });

    const updated = { provider: 'openai', sandboxEnabled: false };
    mocks.store.getAll
      .mockReturnValueOnce({ provider: 'anthropic', sandboxEnabled: true })
      .mockReturnValue(updated);

    const result = await invoke('config.save', { provider: 'openai', trayEnabled: false });

    expect(mocks.store.update).toHaveBeenCalledWith({ provider: 'openai', trayEnabled: false });
    expect(reloadConfig).toHaveBeenCalledTimes(1);
    expect(reloadSandbox).toHaveBeenCalledTimes(1);
    expect(applyBackgroundAccessSetting).toHaveBeenCalledWith(false);
    expect(mocks.exportOnConfigChange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, config: updated });
  });

  it('config.save leaves the tray helper untouched when trayEnabled is absent', async () => {
    const { applyBackgroundAccessSetting } = register();
    await invoke('config.save', { provider: 'openai' });
    expect(applyBackgroundAccessSetting).not.toHaveBeenCalled();
  });

  it('config.test maps a thrown error into a structured failure', async () => {
    register();
    mocks.apiTest.mockRejectedValueOnce(new Error('nope'));
    expect(await invoke('config.test', { provider: 'openai' })).toEqual({
      ok: false,
      errorType: 'unknown',
      details: 'nope',
    });

    mocks.apiTest.mockResolvedValueOnce({ ok: true });
    expect(await invoke('config.test', { provider: 'openai' })).toEqual({ ok: true });
  });

  it('config.listModels only queries ollama', async () => {
    register();
    mocks.listOllamaModels.mockResolvedValue([{ id: 'llama3' }]);
    expect(await invoke('config.listModels', { provider: 'openai', apiKey: 'k' })).toEqual([]);
    expect(mocks.listOllamaModels).not.toHaveBeenCalled();

    expect(
      await invoke('config.listModels', { provider: 'ollama', apiKey: 'k', baseUrl: 'http://x' })
    ).toEqual([{ id: 'llama3' }]);
  });
});
