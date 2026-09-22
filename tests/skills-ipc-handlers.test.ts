import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  skills: {
    listSkills: vi.fn(),
    installSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    validateSkillFolder: vi.fn(),
    getGlobalSkillsPath: vi.fn(),
    setGlobalSkillsPath: vi.fn(),
  },
  plugins: {
    listCatalog: vi.fn(),
    listInstalled: vi.fn(),
    install: vi.fn(),
    setEnabled: vi.fn(),
    setComponentEnabled: vi.fn(),
    uninstall: vi.fn(),
  },
  session: { invalidateSkillsSetup: vi.fn() },
  store: { isConfigured: vi.fn(), getAll: vi.fn(), get: vi.fn() },
  proposals: { listProposals: vi.fn(), approveProposal: vi.fn(), rejectProposal: vi.fn() },
  doctor: { buildSkillDoctorReport: vi.fn(), loadSkillSourcesFromDir: vi.fn() },
  openPath: vi.fn(),
  sendToRenderer: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
  app: {
    isPackaged: false,
    getPath: () => '/userData',
    getVersion: () => '3.5.0',
  },
  shell: { openPath: mocks.openPath },
}));
vi.mock('../src/main/config/config-store', () => ({ configStore: mocks.store }));
vi.mock('../src/main/mods/skill-doctor', () => ({
  buildSkillDoctorReport: mocks.doctor.buildSkillDoctorReport,
  loadSkillSourcesFromDir: mocks.doctor.loadSkillSourcesFromDir,
}));
vi.mock('../src/main/skills/skill-proposals', () => mocks.proposals);
vi.mock('../src/main/events/renderer-sender', () => ({
  sendToRenderer: mocks.sendToRenderer,
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { registerSkillsIpcHandlers } from '../src/main/ipc/skills-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

const register = (options: { withManagers?: boolean } = {}) => {
  const withManagers = options.withManagers !== false;
  registerSkillsIpcHandlers({
    getSkillsManager: () => (withManagers ? (mocks.skills as never) : null),
    getPluginRuntimeService: () => (withManagers ? (mocks.plugins as never) : null),
    getSessionManager: () => mocks.session as never,
  });
};

describe('skills and plugin IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
    mocks.skills.getGlobalSkillsPath.mockReturnValue('/skills');
    mocks.store.isConfigured.mockReturnValue(true);
    mocks.store.getAll.mockReturnValue({ provider: 'anthropic' });
  });

  it('registers every skills.* and plugins.* channel', () => {
    register();
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'plugins.install',
      'plugins.listCatalog',
      'plugins.listInstalled',
      'plugins.setComponentEnabled',
      'plugins.setEnabled',
      'plugins.uninstall',
      'skills.approveProposal',
      'skills.delete',
      'skills.doctor',
      'skills.getAll',
      'skills.getStoragePath',
      'skills.install',
      'skills.listProposals',
      'skills.openStoragePath',
      'skills.rejectProposal',
      'skills.setEnabled',
      'skills.setStoragePath',
      'skills.validate',
    ]);
  });

  it('skills.getAll throws while the manager is still starting', async () => {
    register({ withManagers: false });
    await expect(invoke('skills.getAll')).rejects.toThrow('Skills manager is still starting');
  });

  it('skills.install invalidates the cached agent skills setup', async () => {
    register();
    mocks.skills.installSkill.mockResolvedValue({ id: 's1' });
    expect(await invoke('skills.install', '/tmp/skill')).toEqual({
      success: true,
      skill: { id: 's1' },
    });
    expect(mocks.session.invalidateSkillsSetup).toHaveBeenCalledTimes(1);
  });

  it('skills.setStoragePath persists, notifies the renderer and reports success', async () => {
    register();
    mocks.skills.setGlobalSkillsPath.mockResolvedValue({ migrated: 2 });
    expect(await invoke('skills.setStoragePath', '/new', false)).toEqual({
      success: true,
      migrated: 2,
    });
    expect(mocks.skills.setGlobalSkillsPath).toHaveBeenCalledWith('/new', false);
    expect(mocks.sendToRenderer).toHaveBeenCalledWith({
      type: 'config.status',
      payload: { isConfigured: true, config: { provider: 'anthropic' } },
    });
  });

  it('skills.approveProposal validates the name and surfaces structured codes', async () => {
    register();
    expect(await invoke('skills.approveProposal', '  ')).toEqual({
      success: false,
      error: 'Skill name is required.',
    });
    expect(mocks.proposals.approveProposal).not.toHaveBeenCalled();

    mocks.proposals.approveProposal.mockReturnValue({
      ok: false,
      code: 'conflict',
      error: 'taken',
    });
    expect(await invoke('skills.approveProposal', 'draft')).toEqual({
      success: false,
      code: 'conflict',
      error: 'taken',
    });

    mocks.proposals.approveProposal.mockReturnValue({
      ok: true,
      name: 'draft',
      path: '/skills/draft',
    });
    expect(await invoke('skills.approveProposal', 'draft', 'renamed')).toEqual({
      success: true,
      name: 'draft',
      path: '/skills/draft',
    });
    expect(mocks.proposals.approveProposal).toHaveBeenCalledWith('draft', '/skills', 'renamed');
  });

  it('plugins.setComponentEnabled only invalidates skills when the skills component changes', async () => {
    register();
    mocks.plugins.setComponentEnabled.mockResolvedValue({ success: true });

    await invoke('plugins.setComponentEnabled', 'p1', 'commands', true);
    expect(mocks.session.invalidateSkillsSetup).not.toHaveBeenCalled();

    await invoke('plugins.setComponentEnabled', 'p1', 'skills', false);
    expect(mocks.session.invalidateSkillsSetup).toHaveBeenCalledTimes(1);
  });

  it('plugins.* throws while the runtime service is not initialized', async () => {
    register({ withManagers: false });
    await expect(invoke('plugins.listInstalled')).rejects.toThrow(
      'PluginRuntimeService not initialized'
    );
  });

  it('skills.doctor scans the built-in and user skill directories', async () => {
    register();
    mocks.doctor.loadSkillSourcesFromDir.mockReturnValue([{ name: 'a' }]);
    mocks.doctor.buildSkillDoctorReport.mockReturnValue({ total: 2 });
    mocks.store.get.mockReturnValue(200000);

    expect(await invoke('skills.doctor')).toEqual({
      success: true,
      report: { total: 2 },
    });
    expect(mocks.doctor.loadSkillSourcesFromDir).toHaveBeenCalledTimes(2);
    expect(mocks.doctor.buildSkillDoctorReport).toHaveBeenCalledWith(
      [{ name: 'a' }, { name: 'a' }],
      200000
    );
  });
});
