import { describe, expect, it } from 'vitest';
import { NotificationCenter } from '../src/main/agent/notification-center';

function center(limit = 200) {
  const clock = { value: 100 };
  let counter = 0;
  const instance = new NotificationCenter({
    now: () => clock.value,
    idFactory: () => 'n' + ++counter,
    limit,
  });
  return { instance, clock };
}

describe('NotificationCenter', () => {
  it('records an unacknowledged notification', () => {
    const { instance } = center();
    const notification = instance.notify({
      sessionId: 's1',
      kind: 'approval',
      title: 'Approve plan',
      detail: '2 tasks',
      taskId: 't1',
    });

    expect(notification).toMatchObject({
      id: 'n1',
      sessionId: 's1',
      kind: 'approval',
      title: 'Approve plan',
      detail: '2 tasks',
      taskId: 't1',
      acknowledged: false,
      createdAt: 100,
    });
    expect(instance.unreadCount()).toBe(1);
  });

  it('lists newest first, filters by session and honours the limit', () => {
    const { instance } = center();
    instance.notify({ sessionId: 's1', kind: 'approval', title: 'one' });
    instance.notify({ sessionId: 's2', kind: 'blocker', title: 'two' });

    expect(instance.list().map((item) => item.title)).toEqual(['two', 'one']);
    expect(instance.list('s1').map((item) => item.title)).toEqual(['one']);
    expect(instance.list(undefined, 1).map((item) => item.title)).toEqual(['two']);
    expect(instance.unread('s2')).toHaveLength(1);
  });

  it('acknowledges one or all notifications', () => {
    const { instance } = center();
    const first = instance.notify({ sessionId: 's1', kind: 'completion', title: 'done' });
    instance.notify({ sessionId: 's1', kind: 'error', title: 'failed' });

    expect(instance.acknowledge(first.id)?.acknowledged).toBe(true);
    expect(instance.acknowledge('missing')).toBeNull();
    expect(instance.unreadCount('s1')).toBe(1);
    expect(instance.acknowledgeAll('s1')).toBe(1);
    expect(instance.unreadCount('s1')).toBe(0);
  });

  it('counts by kind and clears', () => {
    const { instance } = center();
    instance.notify({ sessionId: 's1', kind: 'approval', title: 'a' });
    instance.notify({ sessionId: 's1', kind: 'approval', title: 'b' });
    instance.notify({ sessionId: 's2', kind: 'blocker', title: 'c' });

    expect(instance.countsByKind('s1')).toEqual({ approval: 2, blocker: 0, completion: 0, error: 0 });
    expect(instance.clear('s1')).toBe(2);
    expect(instance.size()).toBe(1);
    expect(instance.clear()).toBe(1);
  });

  it('evicts beyond its limit', () => {
    const { instance } = center(1);
    instance.notify({ sessionId: 's1', kind: 'approval', title: 'one' });
    instance.notify({ sessionId: 's1', kind: 'approval', title: 'two' });

    expect(instance.size()).toBe(1);
    expect(instance.list()[0].title).toBe('two');
  });
});
