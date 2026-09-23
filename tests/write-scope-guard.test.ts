import { describe, it, expect } from 'vitest';
import type { AtomicTask } from '../src/shared/task-contract';
import {
  createWriteScopeGuard,
  shellWriteTargets,
  toolCallCommand,
} from '../src/main/agent/write-scope-guard';

function makeTask(
  overrides: Partial<AtomicTask> = {}
): Pick<AtomicTask, 'id' | 'writeScope' | 'requestedCapabilities'> {
  return {
    id: 't1',
    writeScope: ['src/**'],
    requestedCapabilities: ['read', 'write', 'shell'],
    ...overrides,
  };
}

describe('shellWriteTargets', () => {
  it('finds redirection targets', () => {
    expect(shellWriteTargets('echo hi > src/a.ts')).toContain('src/a.ts');
    expect(shellWriteTargets('echo hi >> src/a.ts 2> src/b.log')).toEqual(
      expect.arrayContaining(['src/a.ts', 'src/b.log'])
    );
  });

  it('ignores device and descriptor redirects', () => {
    expect(shellWriteTargets('npm test 2>/dev/null')).toEqual([]);
    expect(shellWriteTargets('cmd >/dev/null 2>&1')).toEqual([]);
  });

  it('finds the common file-writing utilities', () => {
    expect(shellWriteTargets('sed -i "s/a/b/" src/a.ts')).toEqual(['src/a.ts']);
    expect(shellWriteTargets('cp a.ts src/b.ts')).toEqual(['src/b.ts']);
    expect(shellWriteTargets('rm -rf build')).toEqual(['build']);
    expect(shellWriteTargets('mkdir -p src/nested')).toEqual(['src/nested']);
    expect(shellWriteTargets('tee src/out.log')).toEqual(['src/out.log']);
    expect(shellWriteTargets('dd if=x of=src/out.bin')).toEqual(['src/out.bin']);
    expect(shellWriteTargets('chmod 755 src/a.ts')).toEqual(['src/a.ts']);
    expect(shellWriteTargets('git rm -r src/old.ts')).toEqual(['src/old.ts']);
    expect(shellWriteTargets('git checkout -- src/a.ts')).toEqual(['src/a.ts']);
  });

  it('leaves git commands that name no path alone', () => {
    expect(shellWriteTargets('git commit -m "x"')).toEqual([]);
    expect(shellWriteTargets('git checkout main')).toEqual([]);
  });

  it('does not mistake read-only commands for writes', () => {
    expect(shellWriteTargets('npm test')).toEqual([]);
    expect(shellWriteTargets('git status')).toEqual([]);
    expect(shellWriteTargets('sed "s/a/b/" src/a.ts')).toEqual([]);
    expect(shellWriteTargets('cat src/a.ts | grep foo')).toEqual([]);
  });

  it('parses commands chained with operators', () => {
    expect(shellWriteTargets('npm test && echo ok > src/done.txt')).toEqual(['src/done.txt']);
    expect(shellWriteTargets('cd src && rm old.ts')).toEqual(['old.ts']);
  });
});

describe('createWriteScopeGuard', () => {
  it('blocks a shell write outside the declared scope', () => {
    const guard = createWriteScopeGuard(makeTask(), '/ws');
    const verdict = guard({ toolName: 'bash', args: { command: 'echo x > /tmp/evil' } });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('outside the declared write scope');
  });

  it('allows a shell write inside the declared scope', () => {
    const guard = createWriteScopeGuard(makeTask(), '/ws');
    expect(guard({ toolName: 'bash', args: { command: 'echo x > src/a.ts' } })).toBeUndefined();
  });

  it('blocks any shell write for a read-only task', () => {
    const guard = createWriteScopeGuard(makeTask({ writeScope: [] }), '/ws');
    const verdict = guard({ toolName: 'bash', args: { command: 'rm -rf src' } });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('read-only');
  });

  it('still allows read-only shell diagnostics on a read-only task', () => {
    const guard = createWriteScopeGuard(makeTask({ writeScope: [] }), '/ws');
    expect(guard({ toolName: 'bash', args: { command: 'npm test' } })).toBeUndefined();
  });

  it('refuses shell without the shell capability', () => {
    const guard = createWriteScopeGuard(
      makeTask({ requestedCapabilities: ['read', 'write'] }),
      '/ws'
    );
    const verdict = guard({ toolName: 'bash', args: { command: 'npm test' } });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('shell capability');
  });
});

describe('toolCallCommand', () => {
  it('reads the command from the known argument shapes', () => {
    expect(toolCallCommand({ command: 'ls' })).toBe('ls');
    expect(toolCallCommand({ cmd: 'ls' })).toBe('ls');
    expect(toolCallCommand({})).toBeNull();
    expect(toolCallCommand(null)).toBeNull();
  });
});
