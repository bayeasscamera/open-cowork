import { describe, expect, it } from 'vitest';
import { ActivityTracker } from '../src/main/agent/activity-tracker';

function tracker(limit = 500) {
  const clock = { value: 1000 };
  let counter = 0;
  const instance = new ActivityTracker({
    now: () => clock.value,
    idFactory: () => 'a' + ++counter,
    limit,
  });
  return { instance, clock };
}

describe('ActivityTracker', () => {
  it('records a running event with its optional context', () => {
    const { instance } = tracker();
    const event = instance.begin({ sessionId: 's1', tool: 'bash', label: 'npm test', taskId: 't1', detail: 'cwd=/ws' });

    expect(event).toMatchObject({
      id: 'a1',
      sessionId: 's1',
      tool: 'bash',
      label: 'npm test',
      taskId: 't1',
      detail: 'cwd=/ws',
      status: 'running',
      startedAt: 1000,
    });
    expect(instance.size()).toBe(1);
    expect(instance.running()).toHaveLength(1);
  });

  it('closes an event with a status, duration and error', () => {
    const { instance, clock } = tracker();
    const event = instance.begin({ sessionId: 's1', tool: 'read', label: 'read src/a.ts' });

    clock.value = 1250;
    const finished = instance.finish(event.id, { status: 'error', error: 'ENOENT' });

    expect(finished?.status).toBe('error');
    expect(finished?.finishedAt).toBe(1250);
    expect(finished?.durationMs).toBe(250);
    expect(finished?.error).toBe('ENOENT');
    expect(instance.running()).toHaveLength(0);
  });

  it('cancels an event and ignores unknown ids', () => {
    const { instance } = tracker();
    const event = instance.begin({ sessionId: 's1', tool: 'bash', label: 'sleep' });

    expect(instance.cancel(event.id, 'user stopped')?.status).toBe('cancelled');
    expect(instance.cancel(event.id, 'user stopped')?.error).toBe('user stopped');
    expect(instance.finish('missing', { status: 'ok' })).toBeNull();
    expect(instance.get('missing')).toBeNull();
  });

  it('lists newest first and honours the limit', () => {
    const { instance } = tracker();
    instance.begin({ sessionId: 's1', tool: 'a', label: 'first' });
    instance.begin({ sessionId: 's1', tool: 'b', label: 'second' });

    expect(instance.list().map((event) => event.label)).toEqual(['second', 'first']);
    expect(instance.list(1).map((event) => event.label)).toEqual(['second']);
    expect(instance.list(0)).toEqual([]);
  });

  it('filters by session and by task', () => {
    const { instance } = tracker();
    instance.begin({ sessionId: 's1', tool: 'a', label: 'one', taskId: 't1' });
    instance.begin({ sessionId: 's2', tool: 'b', label: 'two' });

    expect(instance.forSession('s1').map((event) => event.label)).toEqual(['one']);
    expect(instance.forSession('s2')).toHaveLength(1);
    expect(instance.forTask('t1').map((event) => event.label)).toEqual(['one']);
  });

  it('summarizes by status', () => {
    const { instance } = tracker();
    const first = instance.begin({ sessionId: 's1', tool: 'a', label: 'one' });
    instance.begin({ sessionId: 's1', tool: 'b', label: 'two' });
    instance.finish(first.id, { status: 'ok' });

    expect(instance.summary()).toEqual({ running: 1, ok: 1, error: 0, cancelled: 0 });
  });

  it('evicts the oldest events beyond its limit', () => {
    const { instance } = tracker(2);
    instance.begin({ sessionId: 's1', tool: 'a', label: 'one' });
    instance.begin({ sessionId: 's1', tool: 'b', label: 'two' });
    instance.begin({ sessionId: 's1', tool: 'c', label: 'three' });

    expect(instance.size()).toBe(2);
    expect(instance.list().map((event) => event.label)).toEqual(['three', 'two']);
  });

  it('clears one session or everything', () => {
    const { instance } = tracker();
    instance.begin({ sessionId: 's1', tool: 'a', label: 'one' });
    instance.begin({ sessionId: 's2', tool: 'b', label: 'two' });

    expect(instance.clear('s1')).toBe(1);
    expect(instance.forSession('s2')).toHaveLength(1);
    expect(instance.clear()).toBe(1);
    expect(instance.size()).toBe(0);
  });
});
