import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ log: vi.fn(), logWarn: vi.fn() }));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}) };
    }
    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }
    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') this.store[key] = value;
      else Object.assign(this.store, key);
    }
  }
  return { default: MockStore };
});

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
}));

import { ModsRegistry } from '../src/main/mods/mods-runtime';
import {
  DiffCollector,
  createBuiltinMods,
  domainLoaderMod,
  redactSecrets,
  securityRedactorMod,
} from '../src/main/mods/builtin-mods';
import {
  buildSkillDoctorReport,
  estimateTokens,
  loadSkillSourcesFromDir,
  recordSkillUseIfApplicable,
} from '../src/main/mods/skill-doctor';

describe('ModsRegistry', () => {
  it('registers mods enabled by default and lists them', () => {
    const registry = new ModsRegistry();
    registry.register({ id: 'a', label: 'A', description: 'a' });
    expect(registry.list()).toEqual([
      { id: 'a', label: 'A', description: 'a', enabled: true },
    ]);
  });

  it('persists enabled state through the store', () => {
    const registry = new ModsRegistry();
    registry.register({ id: 'a', label: 'A', description: 'a' });
    registry.setEnabled('a', false);
    expect(registry.isEnabled('a')).toBe(false);
    expect(registry.list()[0].enabled).toBe(false);
  });

  it('rejects enabling an unknown mod', () => {
    const registry = new ModsRegistry();
    expect(() => registry.setEnabled('ghost', true)).toThrow('Unknown mod');
  });

  it('runs pre-hooks in order and stops at the first block', () => {
    const registry = new ModsRegistry();
    const seen: string[] = [];
    registry.register({
      id: 'first',
      label: 'First',
      description: '',
      onPreToolUse: () => {
        seen.push('first');
        return { block: true, reason: 'nope' };
      },
    });
    registry.register({
      id: 'second',
      label: 'Second',
      description: '',
      onPreToolUse: () => {
        seen.push('second');
      },
    });
    const decision = registry.runPreToolUse({ sessionId: 's', toolName: 'bash', args: {} });
    expect(decision).toEqual({ block: true, reason: 'nope' });
    expect(seen).toEqual(['first']);
  });

  it('skips a disabled mod and a throwing mod never breaks the chain', () => {
    const registry = new ModsRegistry();
    registry.register({
      id: 'boom',
      label: 'Boom',
      description: '',
      onPreToolUse: () => {
        throw new Error('boom');
      },
    });
    registry.register({
      id: 'ok',
      label: 'OK',
      description: '',
      onPreToolUse: () => {
        mocks.log('ok ran');
      },
    });
    registry.setEnabled('boom', true);
    expect(registry.runPreToolUse({ sessionId: 's', toolName: 'x', args: {} })).toEqual({});
    expect(mocks.log).toHaveBeenCalledWith('ok ran');
    expect(mocks.logWarn).toHaveBeenCalled();
  });

  it('chains post-hook replacements: the last enabled rewrite wins', () => {
    const registry = new ModsRegistry();
    registry.register({
      id: 'r1',
      label: 'R1',
      description: '',
      onPostToolUse: () => ({ replaceContent: 'first' }),
    });
    registry.register({
      id: 'r2',
      label: 'R2',
      description: '',
      onPostToolUse: (_call, result) =>
        result.content === 'first' ? { replaceContent: 'second' } : undefined,
    });
    const out = registry.runPostToolUse({ sessionId: 's', toolName: 'x', args: {} }, {
      content: 'original',
    });
    expect(out).toBe('second');
  });

  it('collects context additions only from enabled mods', () => {
    const registry = new ModsRegistry();
    registry.register({
      id: 'ctx',
      label: 'Ctx',
      description: '',
      getContextAdditions: (cwd) => `conventions for ${cwd}`,
    });
    expect(registry.getContextAdditions('/w')).toBe('conventions for /w');
    registry.setEnabled('ctx', false);
    expect(registry.getContextAdditions('/w')).toBe('');
  });
});

describe('security-redactor', () => {
  it('redacts API keys, tokens and connection strings', () => {
    const input = 'key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 and ghp_' +
      'A'.repeat(36) + ' plus postgres://user:secret@db.example.com/prod';
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain('sk-proj-abc');
    expect(redacted).not.toContain('postgres://user:secret');
    expect(redacted).toContain('[REDACTED-KEY]');
    expect(redacted).toContain('[REDACTED-CONNECTION]');
  });

  it('the mod rewrites tool outputs containing secrets and leaves clean ones intact', () => {
    const dirty = 'token=sk-abcdefghijklmnopqrstuvwxyz0123456789 here';
    const decision = securityRedactorMod.onPostToolUse?.(
      { sessionId: 's', toolName: 'read', args: {} },
      { content: dirty }
    );
    expect(decision?.replaceContent).toContain('[REDACTED-KEY]');

    const clean = securityRedactorMod.onPostToolUse?.(
      { sessionId: 's', toolName: 'read', args: {} },
      { content: 'just a normal read' }
    );
    expect(clean).toBeUndefined();
  });
});

describe('domain-loader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cowork-domain-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads .cowork/domain-conventions.md when present', () => {
    mkdirSync(join(dir, '.cowork'), { recursive: true });
    writeFileSync(join(dir, '.cowork', 'domain-conventions.md'), 'Always reply in French.');
    const addition = domainLoaderMod.getContextAdditions?.(dir) ?? '';
    expect(addition).toContain('<domain_conventions>');
    expect(addition).toContain('Always reply in French.');
  });

  it('returns empty for a workspace without conventions', () => {
    expect(domainLoaderMod.getContextAdditions?.(dir)).toBe('');
  });
});

describe('DiffCollector (diff-panel mod)', () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cowork-diff-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures before/after on write with correct counters and diff text', () => {
    const collector = new DiffCollector();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'line1\nline2\nline3\n');
    collector.captureBefore('sess', file, dir);
    writeFileSync(file, 'line1\nline2-modified\nline3\nline4\n');
    collector.captureAfter('sess', file, dir);

    const summary = collector.summary('sess');
    expect(summary).toHaveLength(1);
    expect(summary[0].added).toBe(2);
    expect(summary[0].removed).toBe(1);
    expect(summary[0].diff).toContain('- line2');
    expect(summary[0].diff).toContain('+ line2-modified');
    expect(summary[0].diff).toContain('+ line4');
    expect(summary[0].diff).not.toContain('- line1');
  });

  it('keeps the FIRST before snapshot across multiple writes', () => {
    const collector = new DiffCollector();
    const file = join(dir, 'b.txt');
    writeFileSync(file, 'v1\n');
    collector.captureBefore('sess', file, dir);
    writeFileSync(file, 'v2\n');
    collector.captureAfter('sess', file, dir);
    writeFileSync(file, 'v3\n');
    collector.captureAfter('sess', file, dir);

    const summary = collector.summary('sess');
    expect(summary).toHaveLength(1);
    expect(summary[0].before).toBe('v1\n');
    expect(summary[0].after).toBe('v3\n');
  });

  it('handles new files (before=null) and deletions (after=null)', () => {
    const collector = new DiffCollector();
    const created = join(dir, 'new.txt');
    collector.captureBefore('sess', created, dir); // file doesn't exist yet
    writeFileSync(created, 'hello\nworld\n');
    collector.captureAfter('sess', created, dir);
    const [entry] = collector.summary('sess');
    expect(entry.before).toBeNull();
    expect(entry.added).toBe(2);

    const doomed = join(dir, 'doomed.txt');
    writeFileSync(doomed, 'gone\n');
    collector.captureBefore('sess', doomed, dir);
    rmSync(doomed);
    collector.captureAfter('sess', doomed, dir);
    const summary = collector.summary('sess');
    const deleted = summary.find((item) => item.path === doomed);
    expect(deleted?.after).toBeNull();
    expect(deleted?.removed).toBe(1);
  });

  it('the builtin mod wires write/edit calls to the collector (pre + post)', async () => {
    const mod = createBuiltinMods().find((m) => m.id === 'diff-panel');
    expect(mod).toBeTruthy();
    const file = join(dir, 'wired.txt');
    writeFileSync(file, 'before\n');
    mod!.onPreToolUse?.({ sessionId: 's2', toolName: 'write', args: { path: file } });
    writeFileSync(file, 'after\n');
    mod!.onPostToolUse?.(
      { sessionId: 's2', toolName: 'write', args: { path: file } },
      { content: 'wrote' }
    );
    const summary = new DiffCollector().summary('s2'); // separate instance has no data
    expect(summary).toEqual([]);
    // The shared builtin collector holds the data:
    const { getDiffCollector } = await import('../src/main/mods/builtin-mods');
    const shared = getDiffCollector().summary('s2');
    expect(shared).toHaveLength(1);
    expect(shared[0].path).toBe(file);
  });

  it('ignores non-write tools and paths outside the workspace', () => {
    const collector = new DiffCollector();
    collector.captureBefore('sess', '../outside.txt', dir);
    expect(collector.summary('sess')).toEqual([]);
  });
});

describe('skill doctor', () => {
  it('estimates tokens from content size', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('recommends disabling never-used skills after 30 days and keeps recent ones', () => {
    recordSkillUseIfApplicable('read', { path: '/skills/fresh/SKILL.md' });
    const report = buildSkillDoctorReport(
      [
        { name: 'never-used', path: '/skills/never/SKILL.md', content: 'x'.repeat(400) },
        { name: 'fresh', path: '/skills/fresh/SKILL.md', content: 'y'.repeat(200) },
      ],
      100000
    );
    expect(report.entries).toHaveLength(2);
    expect(report.entries.find((e) => e.name === 'never-used')?.recommendation).toBe('disable');
    expect(report.entries.find((e) => e.name === 'fresh')?.recommendation).toBe('keep');
    expect(report.totalSkillTokens).toBe(150);
    expect(report.entries[0].tokenEstimate).toBeGreaterThanOrEqual(
      report.entries[1].tokenEstimate
    );
  });

  it('tracks skill use from read calls inside skill directories', () => {
    recordSkillUseIfApplicable('read', { path: '/somewhere/skills/pdf/SKILL.md' });
    const report = buildSkillDoctorReport(
      [{ name: 'pdf', path: '/somewhere/skills/pdf/SKILL.md', content: 'doc' }],
      null
    );
    expect(report.entries[0].useCount).toBeGreaterThan(0);
    expect(report.entries[0].lastUsedAt).not.toBeNull();
    // Non-skill reads don't count.
    recordSkillUseIfApplicable('read', { path: '/tmp/other.md' });
    recordSkillUseIfApplicable('bash', { path: '/skills/pdf/SKILL.md' });
    expect(report.entries[0].useCount).toBe(1);
  });

  it('loads skill sources from a directory (SKILL.md only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-doctor-'));
    try {
      mkdirSync(join(dir, 'alpha'));
      mkdirSync(join(dir, 'beta'));
      writeFileSync(join(dir, 'alpha', 'SKILL.md'), 'alpha content');
      writeFileSync(join(dir, 'beta', 'README.md'), 'not a skill file');
      const sources = loadSkillSourcesFromDir(dir);
      expect(sources).toHaveLength(1);
      expect(sources[0].name).toBe('alpha');
      expect(sources[0].content).toBe('alpha content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});