import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  manager: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    runNow: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { registerScheduleIpcHandlers } from '../src/main/ipc/schedule-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

const register = (
  options: { unsupportedReason?: string | null; title?: string; manager?: boolean } = {}
): ((ready: boolean) => void) => {
  let ready = options.manager !== false;
  registerScheduleIpcHandlers({
    getScheduledTaskManager: () => (ready ? mocks.manager : null),
    getWorkspacePathUnsupportedReason: () => options.unsupportedReason ?? null,
    resolveScheduledTaskTitle: vi.fn().mockResolvedValue(options.title ?? 'Generated title'),
    getProject: vi.fn((id: string) => (id === 'p1' ? { id, workdir: '/project' } : undefined)),
  });
  return (nextReady) => {
    ready = nextReady;
  };
};

describe('schedule IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every schedule.* channel', () => {
    register();
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'schedule.create',
      'schedule.delete',
      'schedule.list',
      'schedule.runNow',
      'schedule.toggle',
      'schedule.update',
    ]);
  });

  it('schedule.list returns [] without a manager and swallows errors', async () => {
    register({ manager: false });
    expect(await invoke('schedule.list')).toEqual([]);

    register();
    mocks.manager.list.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await invoke('schedule.list')).toEqual([]);
  });

  it('resolves the scheduled task manager after IPC registration', async () => {
    const setReady = register({ manager: false });
    expect(await invoke('schedule.list')).toEqual([]);
    setReady(true);
    mocks.manager.list.mockReturnValue([{ id: 't1' }]);
    expect(await invoke('schedule.list')).toEqual([{ id: 't1' }]);
  });

  it('schedule.create trims the prompt, resolves a title and rejects unsupported workspaces', async () => {
    register({ title: 'My task' });
    mocks.manager.create.mockReturnValue({ id: 't1' });

    expect(
      await invoke('schedule.create', { prompt: '  do it  ', cwd: '/w', title: undefined })
    ).toEqual({ id: 't1' });
    expect(mocks.manager.create).toHaveBeenCalledWith({
      prompt: 'do it',
      cwd: '/w',
      title: 'My task',
    });

    mocks.handlers.clear();
    register({ unsupportedReason: 'workspace not allowed' });
    await expect(invoke('schedule.create', { prompt: 'x', cwd: '/w' })).rejects.toThrow(
      'workspace not allowed'
    );
    // only the successful call above reached the manager
    expect(mocks.manager.create).toHaveBeenCalledTimes(1);
  });

  it('schedule.create resolves the workspace from a linked project', async () => {
    register();
    mocks.manager.create.mockReturnValue({ id: 't1' });
    await invoke('schedule.create', { prompt: ' weekly search ', cwd: '/stale', projectId: 'p1' });
    expect(mocks.manager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'weekly search',
        cwd: '/project',
        projectId: 'p1',
      })
    );
  });

  it('schedule.update regenerates the title only when the prompt changes', async () => {
    register({ title: 'Regenerated' });
    mocks.manager.get.mockReturnValue({ id: 't1', prompt: 'old', cwd: '/w', title: 'Old' });
    mocks.manager.update.mockImplementation((_id, updates) => updates);

    const withPrompt = await invoke('schedule.update', 't1', { prompt: ' new ', cwd: '/w2' });
    expect(withPrompt).toEqual({ prompt: 'new', cwd: '/w2', title: 'Regenerated' });

    const titleOnly = await invoke('schedule.update', 't1', { title: 'Custom' });
    // buildScheduledTaskTitle normalizes/labels the user-supplied title
    expect((titleOnly as { title: string }).title).toContain('Custom');
  });

  it('schedule.* throws when the manager is not initialized', async () => {
    register({ manager: false });
    await expect(invoke('schedule.delete', 't1')).rejects.toThrow(
      'Scheduled task manager not initialized'
    );
    await expect(invoke('schedule.toggle', 't1', true)).rejects.toThrow(
      'Scheduled task manager not initialized'
    );
    await expect(invoke('schedule.runNow', 't1')).rejects.toThrow(
      'Scheduled task manager not initialized'
    );
  });
});
