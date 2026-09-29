import { describe, it, expect } from 'vitest';
import { AuditLog } from '../src/main/agent/audit-log';

describe('audit-log', () => {
  it('appends ordered entries with ids and timestamps', () => {
    let tick = 0;
    const log = new AuditLog(() => 100 + tick++);
    const first = log.append({
      action: 'file.write',
      justification: 'apply patch',
      authorization: 'approved',
      capability: 'write',
      files: ['src/a.ts'],
    });
    const second = log.append({
      action: 'shell.exec',
      justification: 'run tests',
      authorization: 'auto',
      capability: 'shell',
      taskId: 't1',
    });

    expect(log.size()).toBe(2);
    expect(first.id).not.toBe(second.id);
    expect(first.at).toBeLessThanOrEqual(second.at);
    expect(log.list()[0].action).toBe('file.write');
  });

  it('filters entries by task', () => {
    const log = new AuditLog();
    log.append({ action: 'a', justification: 'x', authorization: 'auto', taskId: 't1' });
    log.append({ action: 'b', justification: 'y', authorization: 'auto', taskId: 't2' });

    expect(log.forTask('t1')).toHaveLength(1);
    expect(log.forTask('t1')[0].action).toBe('a');
  });

  it('exports a versioned JSON document', () => {
    const log = new AuditLog(() => 42);
    log.append({ action: 'a', justification: 'x', authorization: 'auto' });
    const parsed = JSON.parse(log.exportJson()) as {
      version: number;
      exportedAt: number;
      entries: unknown[];
    };

    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(42);
    expect(parsed.entries).toHaveLength(1);
  });

  it('clears the log without ever reusing an entry id', () => {
    // The old behaviour reset the id sequence on clear(), so the first entry
    // after a clear() could carry the same id as an entry that had already
    // been exported — two different justifications, one identifier.
    let tick = 0;
    const log = new AuditLog(() => 1000 + tick++);
    const first = log.append({ action: 'a', justification: 'x', authorization: 'auto' });
    log.clear();
    const second = log.append({ action: 'b', justification: 'y', authorization: 'auto' });
    expect(log.size()).toBe(1);
    expect(second.id).not.toBe(first.id);
  });

  it('keeps ids unique across repeated clears, whatever the clock does', () => {
    // The collision was timing-dependent: the ids only matched while `now()`
    // returned the same value, so a fast machine hid it.
    let tick = 0;
    const log = new AuditLog(() => 1000 + tick++ * 37);
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const entry = log.append({ action: 'a', justification: 'x', authorization: 'auto' });
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
      if (i % 3 === 0) log.clear();
    }
    expect(seen.size).toBe(20);
  });

  it('numbers entries in order within a log', () => {
    const log = new AuditLog(() => 7);
    const first = log.append({ action: 'a', justification: 'x', authorization: 'auto' });
    const second = log.append({ action: 'b', justification: 'y', authorization: 'auto' });
    expect(first.id).not.toBe(second.id);
    expect(first.id.startsWith('audit-1-')).toBe(true);
    expect(second.id.startsWith('audit-2-')).toBe(true);
  });
});
