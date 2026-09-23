import { describe, expect, it } from 'vitest';
import { ControlCenterService } from '../src/main/agent/control-center-service';
import type { GitRunner } from '../src/main/agent/checkpoint-manager';
import type { CommandRunner } from '../src/main/workspace/test-runner';

const gitRunner = (stdout: string): GitRunner => ({
  run: async () => ({ exitCode: 0, stdout, stderr: '' }),
});

function buildService(roots: Record<string, string>) {
  const runner: CommandRunner = {
    run: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
  };
  let counter = 0;
  return new ControlCenterService({
    resolveWorkspaceRoot: (sessionId) => roots[sessionId] ?? null,
    gitFactory: () => gitRunner('## main...origin/main\n M src/a.ts\n'),
    runner,
    idFactory: () => 'id-' + ++counter,
  });
}

describe('ControlCenterService', () => {
  it('returns null or empty workspace probes without a workspace', async () => {
    const service = buildService({});

    expect(service.workspaceRoot('s1')).toBeNull();
    expect(await service.gitStatus('s1')).toBeNull();
    expect(await service.workspaceTree('s1')).toEqual([]);
    await expect(service.readFile('s1', 'a.ts')).rejects.toThrow('No workspace is available');
    await expect(service.runTests('s1', 'npm-test')).rejects.toThrow('No workspace is available');
    expect(service.lastTestResult('s1')).toBeNull();
  });

  it('reads git status through the injected runner', async () => {
    const service = buildService({ s1: '/ws' });
    const status = await service.gitStatus('s1');
    expect(status?.branch).toBe('main');
    expect(status?.modified).toEqual(['src/a.ts']);
  });

  it('runs whitelisted tests and caches the last result per session', async () => {
    const service = buildService({ s1: '/ws' });
    const result = await service.runTests('s1', 'npm-test');

    expect(result.ok).toBe(true);
    expect(result.command).toBe('npm test');
    expect(service.lastTestResult('s1')?.id).toBe(result.id);
    expect(service.lastTestResult('s2')).toBeNull();
  });

  it('composes a snapshot from every pane', async () => {
    const service = buildService({ s1: '/ws' });
    const activity = service.activity.begin({ sessionId: 's1', tool: 'read', label: 'read a.ts' });
    service.activity.finish(activity.id, { status: 'ok' });
    const task = service.queue.enqueue({ sessionId: 's1', kind: 'subagent', label: 'audit' });
    service.queue.start(task.id);
    service.notifications.notify({ sessionId: 's1', kind: 'approval', title: 'Approve' });
    await service.runTests('s1', 'npm-test');

    const snapshot = await service.snapshot('s1');
    expect(snapshot.workspaceRoot).toBe('/ws');
    expect(snapshot.activity).toHaveLength(1);
    expect(snapshot.queue[0]).toMatchObject({ label: 'audit', status: 'running' });
    expect(snapshot.notifications).toHaveLength(1);
    expect(snapshot.git?.branch).toBe('main');
    expect(snapshot.tests?.ok).toBe(true);
    expect(snapshot.generatedAt).toBeGreaterThan(0);
  });
});
