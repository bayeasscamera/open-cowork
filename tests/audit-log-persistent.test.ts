import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      authorization: 'auto',
    });

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
      authorization: 'auto',
    });
    const entry2 = log.append({
      action: 'action2',
      justification: 'just2',
      authorization: 'auto',
    });

    const ndjson = log.exportNdjson();
    const lines = ndjson.split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual(entry1);
    expect(JSON.parse(lines[1])).toEqual(entry2);
  });

  it('each entry has a unique id', () => {
    const log = new AuditLog();
    const e1 = log.append({ action: 'a1', justification: 'j1', authorization: 'auto' });
    const e2 = log.append({ action: 'a2', justification: 'j2', authorization: 'auto' });
    expect(e1.id).not.toBe(e2.id);
  });

  it('list() returns entries in order', () => {
    const log = new AuditLog();
    const e1 = log.append({ action: 'a1', justification: 'j1', authorization: 'auto' });
    const e2 = log.append({ action: 'a2', justification: 'j2', authorization: 'auto' });
    const list = log.list();
    expect(list[0].id).toBe(e1.id);
    expect(list[1].id).toBe(e2.id);
  });

  it('replays entries from existing NDJSON file on construction', () => {
    // First instance writes 2 entries.
    const log1 = new AuditLog(logFile);
    const e1 = log1.append({ action: 'first', justification: 'j1', authorization: 'auto' });
    const e2 = log1.append({ action: 'second', justification: 'j2', authorization: 'auto' });

    // Second instance replays the file — must see both entries.
    const log2 = new AuditLog(logFile);
    const replayed = log2.list();
    expect(replayed.length).toBe(2);
    expect(replayed[0].id).toBe(e1.id);
    expect(replayed[1].id).toBe(e2.id);
  });

  it('restores idCounter so new ids after replay never collide', () => {
    const log1 = new AuditLog(logFile);
    const old = log1.append({ action: 'old', justification: 'j', authorization: 'auto' });

    const log2 = new AuditLog(logFile);
    // log2 already has 'old' from replay; next id must differ.
    const fresh = log2.append({ action: 'new', justification: 'j', authorization: 'auto' });
    expect(fresh.id).not.toBe(old.id);
  });

  it('gracefully ignores malformed lines in NDJSON file', () => {
    fs.writeFileSync(logFile, 'NOT_JSON\n{"id":"x","at":1,"action":"ok","justification":"j","authorization":"auto"}\n');
    // Must not throw and must load the valid line.
    const log = new AuditLog(logFile);
    expect(log.size()).toBe(1);
  });
});
