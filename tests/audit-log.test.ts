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

  it('clears the log and resets the sequence', () => {
    const log = new AuditLog();
    const first = log.append({ action: 'a', justification: 'x', authorization: 'auto' });
    log.clear();
    const second = log.append({ action: 'b', justification: 'y', authorization: 'auto' });
    expect(log.size()).toBe(1);
    expect(second.id).toBe(first.id);
  });
});
