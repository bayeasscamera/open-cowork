import { describe, it, expect } from 'vitest';
import {
  createDefaultPermissionPolicy,
  evaluateBatch,
  evaluateCommand,
  evaluatePermission,
  isPathInsideWorkspace,
  matchGlob,
} from '../src/main/agent/permission-policy';

describe('permission-policy', () => {
  it('matches globs across and within path segments', () => {
    expect(matchGlob('src/**', 'src/a/b.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('*--force*', 'git push --force origin')).toBe(true);
    expect(matchGlob('npm test', 'npm test')).toBe(true);
    expect(matchGlob('npm test', 'npm test --watch')).toBe(false);
  });

  it('detects paths inside the workspace', () => {
    expect(isPathInsideWorkspace('/ws/src/a.ts', '/ws')).toBe(true);
    expect(isPathInsideWorkspace('/ws', '/ws')).toBe(true);
    expect(isPathInsideWorkspace('/other/a.ts', '/ws')).toBe(false);
    expect(isPathInsideWorkspace('/anything', undefined)).toBe(true);
  });

  it('auto-approves safe diagnostics and confirms risky commands', () => {
    const policy = createDefaultPermissionPolicy('/ws');
    expect(evaluateCommand(policy, 'npm test').decision).toBe('auto');
    expect(evaluateCommand(policy, 'npm run typecheck').decision).toBe('auto');
    expect(evaluateCommand(policy, 'git status').decision).toBe('auto');
    expect(evaluateCommand(policy, 'git push origin main').decision).toBe('confirm');
    expect(evaluateCommand(policy, 'npm install').decision).toBe('confirm');
  });

  it('refuses destructive commands', () => {
    const policy = createDefaultPermissionPolicy('/ws');
    const evaluation = evaluateCommand(policy, 'rm -rf /');
    expect(evaluation.decision).toBe('forbidden');
    expect(evaluation.matchedRuleId).toBe('shell.destructive-forbidden');
  });

  it('never escalates for paths inside the workspace', () => {
    const policy = createDefaultPermissionPolicy('/ws');
    const evaluation = evaluatePermission(policy, {
      capability: 'outside-workspace',
      path: '/ws/src/a.ts',
    });
    expect(evaluation.decision).toBe('auto');
    expect(evaluation.matchedRuleId).toBeNull();
  });

  it('forbids access outside the workspace', () => {
    const policy = createDefaultPermissionPolicy('/ws');
    const evaluation = evaluatePermission(policy, {
      capability: 'outside-workspace',
      path: '/etc/passwd',
    });
    expect(evaluation.decision).toBe('forbidden');
  });

  it('blocks a batch when any request is forbidden', () => {
    const policy = createDefaultPermissionPolicy('/ws');
    const batch = evaluateBatch(policy, [
      { capability: 'shell', command: 'npm test' },
      { capability: 'shell', command: 'rm -rf /' },
    ]);
    expect(batch.allowed).toBe(false);
    expect(batch.blocked).toHaveLength(1);
  });

  it('falls back to the policy default when no rule matches', () => {
    const policy = createDefaultPermissionPolicy('/ws');
    const evaluation = evaluatePermission(policy, { capability: 'mcp' });
    expect(evaluation.matchedRuleId).toBe('mcp.requires-confirmation');
    expect(evaluation.reason).toContain('mcp.requires-confirmation');
  });
});
