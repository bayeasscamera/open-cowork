import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { registerControlCenterIpcHandlers } from '../src/main/ipc/control-center-handlers';
import { ControlCenterService } from '../src/main/agent/control-center-service';
import type { GitRunner } from '../src/main/agent/checkpoint-manager';
import type { CommandRunner } from '../src/main/workspace/test-runner';
import type { ActivityEvent, DetachedTask, ApprovalNotification } from '../src/shared/control-center-types';

const git: GitRunner = {
  run: async () => ({ exitCode: 0, stdout: '## main...origin/main\n M src/a.ts\n', stderr: '' }),
};
const runner: CommandRunner = {
  run: async () => ({ exitCode: 0, stdout: 'green', stderr: '', timedOut: false }),
};

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error('no handler for ' + channel);
  return handler({}, ...args);
};

describe('control-center-ipc-handlers', () => {
  let service: ControlCenterService;

  beforeEach(() => {
    mocks.handlers.clear();
    let counter = 0;
    service = new ControlCenterService({
      resolveWorkspaceRoot: (sessionId) => (sessionId === 's1' ? '/ws' : null),
      gitFactory: () => git,
      runner,
      idFactory: () => 'id-' + ++counter,
    });
    registerControlCenterIpcHandlers({ service });
  });

  it('registers the full control center channel surface', () => {
    expect(Array.from(mocks.handlers.keys()).sort()).toEqual([
      'controlCenter.acknowledgeAll',
      'controlCenter.acknowledgeNotification',
      'controlCenter.activity',
      'controlCenter.cancelTask',
      'controlCenter.clearActivity',
      'controlCenter.enqueueTask',
      'controlCenter.finishActivity',
      'controlCenter.gitStatus',
      'controlCenter.notifications',
      'controlCenter.notify',
      'controlCenter.queue',
      'controlCenter.readFile',
      'controlCenter.recordActivity',
      'controlCenter.runTests',
      'controlCenter.snapshot',
      'controlCenter.updateTask',
      'controlCenter.workspaceTree',
    ]);
  });

  it('requires a session id on every workspace probe', async () => {
    await expect(invoke('controlCenter.snapshot', '')).rejects.toThrow('A session id is required.');
    await expect(invoke('controlCenter.readFile', 's1', '   ')).rejects.toThrow(
      'File path must be a non-empty string.'
    );
  });

  it('records and closes tool activity', async () => {
    const started = (await invoke('controlCenter.recordActivity', 's1', {
      tool: 'bash',
      label: 'npm test',
      taskId: 't1',
      detail: 'cwd=/ws',
    })) as ActivityEvent;
    expect(started).toMatchObject({ tool: 'bash', label: 'npm test', status: 'running', taskId: 't1' });

    const finished = (await invoke('controlCenter.finishActivity', 's1', started.id, {
      status: 'ok',
    })) as ActivityEvent;
    expect(finished.status).toBe('ok');
    expect(finished.durationMs).toBeGreaterThanOrEqual(0);

    const listed = (await invoke('controlCenter.activity', 's1')) as ActivityEvent[];
    expect(listed).toHaveLength(1);

    expect(await invoke('controlCenter.clearActivity', 's1')).toEqual({ removed: 1 });
  });

  it('rejects malformed activity payloads', async () => {
    await expect(invoke('controlCenter.recordActivity', 's1', { tool: '', label: 'x' })).rejects.toThrow(
      'Activity tool must be a non-empty string.'
    );
    await expect(
      invoke('controlCenter.finishActivity', 's1', 'missing', { status: 'nope' })
    ).rejects.toThrow('Unknown activity status');
  });

  it('exposes git status and refuses unknown test commands', async () => {
    const status = (await invoke('controlCenter.gitStatus', 's1')) as { branch: string; modified: string[] };
    expect(status.branch).toBe('main');
    expect(status.modified).toEqual(['src/a.ts']);

    await expect(invoke('controlCenter.runTests', 's1', 'rm -rf /')).rejects.toThrow(
      'Unknown test command'
    );
    const result = (await invoke('controlCenter.runTests', 's1', 'npm-test')) as { ok: boolean; command: string };
    expect(result.ok).toBe(true);
    expect(result.command).toBe('npm test');
  });

  it('returns empty probes without a workspace', async () => {
    expect(await invoke('controlCenter.workspaceTree', 's2', {})).toEqual([]);
    expect(await invoke('controlCenter.gitStatus', 's2')).toBeNull();
    await expect(invoke('controlCenter.readFile', 's2', 'a.ts')).rejects.toThrow(
      'No workspace is available'
    );
  });

  it('drives the detached-task queue through its transitions', async () => {
    const task = (await invoke('controlCenter.enqueueTask', 's1', {
      kind: 'subagent',
      label: 'audit',
      resumeToken: 'r1',
    })) as DetachedTask;
    expect(task.status).toBe('queued');

    const running = (await invoke('controlCenter.updateTask', 's1', task.id, 'running')) as DetachedTask;
    expect(running.status).toBe('running');

    const done = (await invoke('controlCenter.updateTask', 's1', task.id, 'completed')) as DetachedTask;
    expect(done.status).toBe('completed');

    await expect(invoke('controlCenter.updateTask', 's1', task.id, 'nope')).rejects.toThrow(
      'Unknown task status'
    );
    expect((await invoke('controlCenter.queue', 's1')) as DetachedTask[]).toHaveLength(1);
  });

  it('cancels a task and returns the queue', async () => {
    const task = (await invoke('controlCenter.enqueueTask', 's1', {
      kind: 'custom',
      label: 'x',
    })) as DetachedTask;
    const cancelled = (await invoke('controlCenter.cancelTask', 's1', task.id)) as DetachedTask;
    expect(cancelled.status).toBe('cancelled');
    expect(await invoke('controlCenter.cancelTask', 's1', 'missing')).toBeNull();
  });

  it('surfaces and acknowledges notifications', async () => {
    const notification = (await invoke('controlCenter.notify', 's1', {
      kind: 'approval',
      title: 'Approve plan',
      detail: '2 tasks',
    })) as ApprovalNotification;
    expect(notification.acknowledged).toBe(false);

    await expect(invoke('controlCenter.notify', 's1', { kind: 'nope', title: 'x' })).rejects.toThrow(
      'Unknown notification kind'
    );
    await expect(invoke('controlCenter.notify', 's1', { kind: 'approval', title: ' ' })).rejects.toThrow(
      'Notification title must be a non-empty string.'
    );

    const acked = (await invoke('controlCenter.acknowledgeNotification', 's1', notification.id)) as ApprovalNotification;
    expect(acked.acknowledged).toBe(true);
    expect(await invoke('controlCenter.acknowledgeAll', 's1')).toEqual({ acknowledged: 0 });
  });

  it('composes a snapshot from every pane', async () => {
    await invoke('controlCenter.recordActivity', 's1', { tool: 'read', label: 'read a.ts' });
    await invoke('controlCenter.enqueueTask', 's1', { kind: 'custom', label: 'x' });
    await invoke('controlCenter.notify', 's1', { kind: 'completion', title: 'done' });
    await invoke('controlCenter.runTests', 's1', 'npm-test');

    const snapshot = (await invoke('controlCenter.snapshot', 's1')) as {
      workspaceRoot: string;
      activity: unknown[];
      queue: unknown[];
      notifications: unknown[];
      git: { branch: string };
      tests: { ok: boolean };
    };
    expect(snapshot.workspaceRoot).toBe('/ws');
    expect(snapshot.activity).toHaveLength(1);
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.notifications).toHaveLength(1);
    expect(snapshot.git.branch).toBe('main');
    expect(snapshot.tests.ok).toBe(true);
  });
});
