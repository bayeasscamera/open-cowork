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
  secretProbe: vi.fn(),
  secretResolve: vi.fn(),
  secretConflicts: vi.fn(),
  secretInvalidate: vi.fn(),
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
vi.mock('../src/main/config/secret-resolver', () => ({
  getSecretResolver: () => ({
    probe: mocks.secretProbe,
    resolveForConfigSet: mocks.secretResolve,
    findConflicts: mocks.secretConflicts,
    invalidate: mocks.secretInvalidate,
  }),
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
      'secrets.getConflicts',
      'secrets.invalidate',
      'secrets.probeSource',
      'secrets.testConfigSet',
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

  describe('external secret sources', () => {
    it('secrets.probeSource delegates to the resolver', async () => {
      register();
      mocks.secretProbe.mockResolvedValue({ installed: true, unlocked: false, detail: 'locked' });
      expect(await invoke('secrets.probeSource', { kind: 'bitwarden' })).toEqual({
        installed: true,
        unlocked: false,
        detail: 'locked',
      });
      expect(mocks.secretProbe).toHaveBeenCalledWith('bitwarden');
    });

    it('secrets.probeSource degrades to a structured failure instead of throwing', async () => {
      register();
      mocks.secretProbe.mockRejectedValueOnce(new Error('boom'));
      expect(await invoke('secrets.probeSource', { kind: '1password' })).toEqual({
        installed: false,
        unlocked: false,
        detail: 'boom',
      });
    });

    it('secrets.testConfigSet reports success without echoing the secret', async () => {
      register();
      mocks.store.getAll.mockReturnValue({
        configSets: [
          { id: 'set-1', activeProfileKey: 'anthropic', profiles: { anthropic: { apiKey: 'op://v/i/f' } } },
        ],
        secretSources: { 'set-1': { kind: '1password', driver: 'cli', reference: 'op://v/i/f' } },
        apiKey: 'op://v/i/f',
      });
      mocks.secretResolve.mockResolvedValue({ value: 'sk-secret', error: null, fromLocal: false });
      const result = (await invoke('secrets.testConfigSet', { configSetId: 'set-1' })) as {
        ok: boolean;
        detail: string;
      };
      expect(result.ok).toBe(true);
      // The detail must describe the secret without containing it.
      expect(result.detail).not.toContain('sk-secret');
    });

    it('secrets.testConfigSet surfaces a typed resolution error', async () => {
      register();
      mocks.store.getAll.mockReturnValue({
        configSets: [],
        secretSources: { 'set-1': { kind: 'bitwarden', driver: 'cli', reference: 'item' } },
        apiKey: '',
      });
      mocks.secretResolve.mockResolvedValue({
        value: null,
        error: { code: 'cli-missing', message: 'bw not found' },
        fromLocal: false,
      });
      expect(await invoke('secrets.testConfigSet', { configSetId: 'set-1' })).toEqual({
        ok: false,
        detail: 'bw not found',
      });
    });

    it('secrets.getConflicts returns the resolver report', async () => {
      register();
      mocks.store.getAll.mockReturnValue({ secretSources: {} });
      const conflicts = [{ configSetId: 's', kinds: ['bitwarden'], winner: 'bitwarden' }];
      mocks.secretConflicts.mockReturnValue(conflicts);
      expect(await invoke('secrets.getConflicts')).toEqual(conflicts);
    });

    it('secrets.invalidate clears the cache and never throws', async () => {
      register();
      mocks.secretInvalidate.mockReturnValue(undefined);
      expect(await invoke('secrets.invalidate')).toEqual({ success: true });
    });
  });
});
