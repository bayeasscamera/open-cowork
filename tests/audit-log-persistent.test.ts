import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AuditLog } from '../src/main/agent/audit-log';

describe('AuditLog Persistence', () => {
  const tempDir = path.join(__dirname, 'temp_audit');
  let logFile: string;

  beforeEach(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    logFile = path.join(tempDir, `audit-${Date.now()}.ndjson`);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('appends to file when logFilePath is provided', () => {
    const log = new AuditLog(logFile);
    log.append({
      action: 'test_action',
      justification: 'test_justification',
      authorization: 'granted'
    } as any);

    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('test_action');
    expect(content).toContain('test_justification');
  });

  it('exportNdjson produces correct format', () => {
    const log = new AuditLog(); // in memory
    const entry1 = log.append({
      action: 'action1',
      justification: 'just1',
      authorization: 'granted'
    } as any);
    const entry2 = log.append({
      action: 'action2',
      justification: 'just2',
      authorization: 'granted'
    } as any);

    const ndjson = log.exportNdjson();
    const lines = ndjson.split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual(entry1);
    expect(JSON.parse(lines[1])).toEqual(entry2);
  });

  it('each entry has a unique id', () => {
    const log = new AuditLog();
    const e1 = log.append({ action: 'a1', justification: 'j1', authorization: 'granted' } as any);
    const e2 = log.append({ action: 'a2', justification: 'j2', authorization: 'granted' } as any);
    expect(e1.id).not.toBe(e2.id);
  });

  it('list() returns entries in order', () => {
    const log = new AuditLog();
    const e1 = log.append({ action: 'a1', justification: 'j1', authorization: 'granted' } as any);
    const e2 = log.append({ action: 'a2', justification: 'j2', authorization: 'granted' } as any);
    const list = log.list();
    expect(list[0].id).toBe(e1.id);
    expect(list[1].id).toBe(e2.id);
  });
});
