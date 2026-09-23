import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { registerControlCenterIpcHandlers } from '../src/main/ipc/control-center-handlers';
import { ControlCenterService } from '../src/main/agent/control-center-service';
import type { GitRunner } from '../src/main/agent/checkpoint-manager';
import type { CommandRunner } from '../src/main/workspace/test-runner';
import type { TerminalChildProcess, TerminalSpawn } from '../src/main/workspace/terminal-manager';
import type {
  ActivityEvent,
  DetachedTask,
  ApprovalNotification,
  TerminalSnapshot,
} from '../src/shared/control-center-types';

const git: GitRunner = {
  run: async () => ({ exitCode: 0, stdout: '## main...origin/main\n M src/a.ts\n', stderr: '' }),
};
const runner: CommandRunner = {
  run: async () => ({ exitCode: 0, stdout: 'green', stderr: '', timedOut: false }),
};

interface FakeTerminalChild extends TerminalChildProcess {
  written: string[];
  killCount: number;
  emitExit(code: number): void;
  emitStdout(chunk: unknown): void;
}

const spawnedTerminals: FakeTerminalChild[] = [];

const fakeSpawn: TerminalSpawn = () => {
  const exitListeners: ((code: unknown) => void)[] = [];
  const stdoutListeners: ((chunk: unknown) => void)[] = [];
  const written: string[] = [];
  let killCount = 0;

  const child: FakeTerminalChild = {
    pid: 7,
    stdin: {
      write: (data: string) => {
        written.push(data);
        return true;
      },
    },
    stdout: {
      on: (_event: string, listener: (chunk: unknown) => void) => {
        stdoutListeners.push(listener);
        return undefined;
      },
    },
    stderr: { on: () => undefined },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        exitListeners.push(listener as (code: unknown) => void);
      }
      return undefined;
    },
    kill: () => {
      killCount += 1;
      return true;
    },
    get written() {
      return written;
    },
    get killCount() {
      return killCount;
    },
    emitExit: (code: number) => {
      for (const listener of exitListeners) {
        listener(code);
      }
    },
    emitStdout: (chunk: unknown) => {
      for (const listener of stdoutListeners) {
        listener(chunk);
      }
    },
  };

  spawnedTerminals.push(child);
  return child;
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
    spawnedTerminals.length = 0;
    let counter = 0;
    service = new ControlCenterService({
      resolveWorkspaceRoot: (sessionId) => (sessionId === 's1' ? '/ws' : null),
      gitFactory: () => git,
      runner,
      idFactory: () => 'id-' + ++counter,
      terminal: { spawn: fakeSpawn, isDirectory: () => true },
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
      'controlCenter.openInEditor',
      'controlCenter.queue',
      'controlCenter.readFile',
      'controlCenter.recordActivity',
      'controlCenter.runTests',
      'controlCenter.snapshot',
      'controlCenter.terminalClear',
      'controlCenter.terminalClose',
      'controlCenter.terminalList',
      'controlCenter.terminalOpen',
      'controlCenter.terminalSnapshot',
      'controlCenter.terminalWrite',
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

  it('refuses to open an editor outside the session workspace', async () => {
    const openExternal = vi.fn(async () => undefined);
    const openPath = vi.fn(async () => '');
    const root = mkdtempSync(join(tmpdir(), 'cc-open-editor-'));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    try {
      const local = new ControlCenterService({
        resolveWorkspaceRoot: (sessionId) => (sessionId === 's1' ? root : null),
        gitFactory: () => git,
        runner,
        editorOpener: { openExternal, openPath },
      });
      mocks.handlers.clear();
      registerControlCenterIpcHandlers({ service: local });

      const opened = (await invoke('controlCenter.openInEditor', 's1', 'a.ts', 3)) as {
        success: boolean;
      };
      expect(opened.success).toBe(true);
      expect(openExternal.mock.calls.length + openPath.mock.calls.length).toBeGreaterThan(0);

      openExternal.mockClear();
      openPath.mockClear();
      expect(await invoke('controlCenter.openInEditor', 's1', '../escape.ts', 1)).toEqual({
        success: false,
        error: 'invalid_target',
      });
      expect(await invoke('controlCenter.openInEditor', 's1', join(root, 'missing.ts'))).toEqual({
        success: false,
        error: 'invalid_target',
      });
      expect(openExternal).not.toHaveBeenCalled();
      expect(openPath).not.toHaveBeenCalled();

      await expect(invoke('controlCenter.openInEditor', 's1', '   ')).rejects.toThrow(
        'File path must be a non-empty string.'
      );
      expect(await invoke('controlCenter.openInEditor', 's2', 'a.ts')).toEqual({
        success: false,
        error: 'no_workspace',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('drives an embedded terminal through the IPC surface', async () => {
    const opened = (await invoke('controlCenter.terminalOpen', 's1')) as TerminalSnapshot;
    expect(opened.session.cwd).toBe('/ws');
    expect(opened.session.sessionId).toBe('s1');
    expect(opened.session.running).toBe(true);

    const child = spawnedTerminals[spawnedTerminals.length - 1];
    child.emitStdout('hello\n');

    const snapshot = (await invoke(
      'controlCenter.terminalSnapshot',
      's1',
      opened.session.id,
      0
    )) as TerminalSnapshot;
    expect(snapshot.output.map((chunk) => chunk.text)).toEqual(['hello\n']);

    expect(await invoke('controlCenter.terminalWrite', 's1', opened.session.id, 'ls')).toEqual({
      ok: true,
    });
    expect(child.written).toEqual(['ls\n']);

    expect((await invoke('controlCenter.terminalList', 's1')) as unknown[]).toHaveLength(1);
    expect(await invoke('controlCenter.terminalClear', 's1', opened.session.id)).toEqual({
      cleared: 1,
    });
    expect(await invoke('controlCenter.terminalClose', 's1', opened.session.id)).toEqual({
      closed: true,
    });
    expect(child.killCount).toBe(1);
  });

  it('refuses to open a terminal outside a workspace', async () => {
    await expect(invoke('controlCenter.terminalOpen', 's2')).rejects.toThrow(
      'No workspace is available'
    );
    expect(spawnedTerminals).toHaveLength(0);
  });
});
