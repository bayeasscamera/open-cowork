import { describe, expect, it } from 'vitest';
import { TaskQueue } from '../src/main/agent/task-queue';

function queue(limit = 200) {
  const clock = { value: 500 };
  let counter = 0;
  const instance = new TaskQueue({
    now: () => clock.value,
    idFactory: () => 't' + ++counter,
    limit,
  });
  return { instance, clock };
}

describe('TaskQueue', () => {
  it('enqueues a detached task', () => {
    const { instance } = queue();
    const task = instance.enqueue({ sessionId: 's1', kind: 'subagent', label: 'audit', resumeToken: 'r1' });

    expect(task).toMatchObject({
      id: 't1',
      sessionId: 's1',
      kind: 'subagent',
      label: 'audit',
      status: 'queued',
      resumeToken: 'r1',
      createdAt: 500,
    });
    expect(instance.pending()).toHaveLength(1);
  });

  it('walks a task through running, completed and failed', () => {
    const { instance, clock } = queue();
    const task = instance.enqueue({ sessionId: 's1', kind: 'test-run', label: 'npm test' });

    clock.value = 600;
    expect(instance.start(task.id)).toMatchObject({ status: 'running', startedAt: 600 });

    clock.value = 900;
    const done = instance.complete(task.id);
    expect(done).toMatchObject({ status: 'completed', finishedAt: 900, progress: 1 });
    expect(instance.pending()).toHaveLength(0);

    const other = instance.enqueue({ sessionId: 's1', kind: 'custom', label: 'x' });
    expect(instance.fail(other.id, 'boom')).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('cancels a task with a reason and clamps progress', () => {
    const { instance } = queue();
    const task = instance.enqueue({ sessionId: 's1', kind: 'custom', label: 'x' });

    expect(instance.setProgress(task.id, 2)?.progress).toBe(1);
    expect(instance.setProgress(task.id, -1)?.progress).toBe(0);
    expect(instance.setProgress('missing', 0.5)).toBeNull();
    expect(instance.cancel(task.id, 'superseded')).toMatchObject({ status: 'cancelled', error: 'superseded' });
    expect(instance.start('missing')).toBeNull();
  });

  it('lists newest first and filters by session', () => {
    const { instance } = queue();
    instance.enqueue({ sessionId: 's1', kind: 'a', label: 'one' });
    instance.enqueue({ sessionId: 's2', kind: 'b', label: 'two' });

    expect(instance.list().map((task) => task.label)).toEqual(['two', 'one']);
    expect(instance.list('s1').map((task) => task.label)).toEqual(['one']);
    expect(instance.stats()).toEqual({ queued: 2, running: 0, completed: 0, failed: 0, cancelled: 0 });
  });

  it('serializes and restores, demoting running tasks to queued', () => {
    const { instance } = queue();
    const task = instance.enqueue({ sessionId: 's1', kind: 'subagent', label: 'long', resumeToken: 'r1' });
    instance.start(task.id);
    const snapshot = instance.serialize();

    const restored = queue();
    expect(restored.instance.restore(snapshot)).toBe(1);
    const back = restored.instance.get('t1');
    expect(back).toMatchObject({ status: 'queued', resumeToken: 'r1' });
    expect(back?.startedAt).toBeUndefined();
  });

  it('skips malformed restore entries and evicts beyond its limit', () => {
    const { instance } = queue(2);
    expect(instance.restore([{ id: 'x' } as never, { id: 'y', sessionId: 's1', kind: 'k', label: 'l', status: 'queued', createdAt: 1 }])).toBe(1);
    instance.enqueue({ sessionId: 's1', kind: 'a', label: 'one' });
    instance.enqueue({ sessionId: 's1', kind: 'b', label: 'two' });
    expect(instance.size()).toBe(2);
    expect(instance.get('y')).toBeNull();
  });

  it('clears one session or everything', () => {
    const { instance } = queue();
    instance.enqueue({ sessionId: 's1', kind: 'a', label: 'one' });
    instance.enqueue({ sessionId: 's2', kind: 'b', label: 'two' });

    expect(instance.clear('s1')).toBe(1);
    expect(instance.list()).toHaveLength(1);
    expect(instance.clear()).toBe(1);
    expect(instance.size()).toBe(0);
  });
});
