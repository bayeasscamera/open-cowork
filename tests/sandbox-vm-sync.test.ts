/**
 * SandboxVmSync base contract tests.
 *
 * SandboxSync (WSL) and LimaSync (Lima) share one registry + sync/cleanup
 * sequence through a static base class. The subtle part of that design is that
 * each subclass shadows the base registry with its own map; these tests pin the
 * isolation down, plus the shared validation and traversal guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandKey, makeExecFileImpl } from './sandbox-bridge-harness';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }));

import SandboxSync from '../src/main/sandbox/sandbox-sync';
import { LimaSync } from '../src/main/sandbox/lima-sync';

function installExec(overrides: Array<[string, unknown]> = []): void {
  mocks.execFile.mockImplementation(
    makeExecFileImpl((command, args) => {
      const full = commandKey(command, args);
      for (const [needle, result] of overrides) {
        if (full.includes(needle)) return result as { stdout?: string } | Error;
      }
      if (full.includes('cd ~ && pwd')) {
        return { stdout: command === 'wsl' ? '/home/wsl\n' : '/home/lima\n' };
      }
      if (full.includes('realpath')) {
        // The cleanup guard requires realpath to resolve inside the sandbox root
        const quoted = /'([^']+)'/.exec(full);
        return { stdout: (quoted ? quoted[1] : '') + '\n' };
      }
      if (full.includes('wc -l')) return { stdout: '4\n' };
      if (full.includes('du -sb')) return { stdout: '8192\n' };
      return { stdout: '' };
    })
  );
}

const initWsl = (sessionId = 's1'): Promise<unknown> =>
  SandboxSync.initSync('D:/proj', sessionId, 'Ubuntu-22.04');

const initLima = (sessionId = 's1'): Promise<unknown> =>
  LimaSync.initSync('/Users/me/proj', sessionId);

beforeEach(() => {
  SandboxSync.clearAllSessions();
  LimaSync.clearAllSessions();
  installExec();
});

describe('SandboxVmSync registry isolation', () => {
  it('keeps one registry per backend', async () => {
    await initWsl('wsl-1');
    await initLima('lima-1');

    expect(SandboxSync.getAllSessionIds()).toEqual(['wsl-1']);
    expect(LimaSync.getAllSessionIds()).toEqual(['lima-1']);
    expect(SandboxSync.hasSession('lima-1')).toBe(false);
    expect(LimaSync.hasSession('wsl-1')).toBe(false);
  });

  it('resolves each backend home directory independently', async () => {
    await initWsl();
    await initLima();

    expect(SandboxSync.getSandboxPath('s1')).toBe('/home/wsl/.claude/sandbox/s1');
    expect(LimaSync.getSandboxPath('s1')).toBe('/home/lima/.claude/sandbox/s1');
  });

  it('stores backend-specific session records under the shared registry', async () => {
    await initWsl();
    await initLima();

    expect(SandboxSync.getSession('s1')).toMatchObject({
      sandboxPath: '/home/wsl/.claude/sandbox/s1',
      windowsPath: 'D:/proj',
      distro: 'Ubuntu-22.04',
      initialized: true,
      fileCount: 4,
      totalSize: 8192,
    });
    expect(LimaSync.getSession('s1')).toMatchObject({
      sandboxPath: '/home/lima/.claude/sandbox/s1',
      macPath: '/Users/me/proj',
      initialized: true,
    });
  });

  it('clears a single session without touching the other backend', async () => {
    await initWsl('shared');
    await initLima('shared');

    SandboxSync.clearSession('shared');

    expect(SandboxSync.getAllSessionIds()).toEqual([]);
    expect(LimaSync.getAllSessionIds()).toEqual(['shared']);
  });

  it('clears every session without touching the other backend', async () => {
    await initWsl('a');
    await initLima('b');

    LimaSync.clearAllSessions();

    expect(LimaSync.getAllSessionIds()).toEqual([]);
    expect(SandboxSync.getAllSessionIds()).toEqual(['a']);
  });
});

describe('SandboxVmSync path containment helpers', () => {
  it('reports paths inside and outside the sandbox', async () => {
    await initWsl('s1');

    expect(SandboxSync.isPathInSandbox('/home/wsl/.claude/sandbox/s1/src/a.ts', 's1')).toBe(true);
    expect(SandboxSync.isPathInSandbox('/home/wsl/elsewhere/a.ts', 's1')).toBe(false);
    expect(SandboxSync.isPathInSandbox('/home/wsl/.claude/sandbox/s1/a.ts', 'missing')).toBe(false);
  });

  it('refuses path traversal in the shared copy path for both backends', async () => {
    await initWsl('s1');
    await initLima('s1');

    const wslResult = await SandboxSync.syncFileToSandbox('s1', 'D:/x', '../../etc/passwd');
    const limaResult = await LimaSync.syncFileToSandbox('s1', '/Users/me/x', '../../etc/passwd');

    expect(wslResult.success).toBe(false);
    expect(wslResult.error).toContain('Path traversal detected');
    expect(limaResult.success).toBe(false);
    expect(limaResult.error).toContain('Path traversal detected');
  });
});

describe('SandboxVmSync shared lifecycle', () => {
  it('reuses a live sandbox instead of copying again', async () => {
    await initWsl();
    const callsAfterInit = mocks.execFile.mock.calls.length;

    const second = (await SandboxSync.initSync('D:/proj', 's1', 'Ubuntu-22.04')) as {
      sandboxPath: string;
      fileCount: number;
    };

    expect(second.sandboxPath).toBe('/home/wsl/.claude/sandbox/s1');
    expect(second.fileCount).toBe(4);
    // Only the "test -d" probe runs on the second call
    expect(mocks.execFile.mock.calls.length).toBe(callsAfterInit + 1);
  });

  it('reinitializes when the sandbox directory disappeared', async () => {
    await initWsl();
    installExec([['test -d', new Error('missing')]]);

    const result = (await SandboxSync.initSync('D:/proj', 's1', 'Ubuntu-22.04')) as {
      success: boolean;
      fileCount: number;
    };

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(4);
  });

  it('is a no-op when cleanupAllSessions has nothing to do', async () => {
    await expect(SandboxSync.cleanupAllSessions()).resolves.toBeUndefined();
    await expect(LimaSync.cleanupAllSessions()).resolves.toBeUndefined();
  });

  it('syncs and deletes every session on cleanupAllSessions', async () => {
    await initWsl('a');
    await initWsl('b');

    await SandboxSync.cleanupAllSessions();

    expect(SandboxSync.getAllSessionIds()).toEqual([]);
    const commands = mocks.execFile.mock.calls.map((call) => commandKey(call[0], call[1]));
    expect(commands.some((command) => command.includes('rm -rf'))).toBe(true);
    expect(commands.some((command) => command.includes('rsync -av --delete'))).toBe(true);
  });

  it('ignores cleanup for an unknown session', async () => {
    await expect(SandboxSync.cleanup('missing')).resolves.toBeUndefined();
    expect(LimaSync.getSession('missing')).toBeUndefined();
  });
});

describe('SandboxVmSync shared validation', () => {
  it('rejects an invalid sessionId for both backends', async () => {
    await expect(SandboxSync.initSync('D:/p', '../evil', 'Ubuntu-22.04')).rejects.toThrow(
      'Invalid sessionId'
    );
    await expect(LimaSync.initSync('/Users/me/p', '../evil')).rejects.toThrow('Invalid sessionId');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('rejects a WSL distro name containing shell metacharacters', async () => {
    await expect(SandboxSync.initSync('D:/p', 's1', 'Ubuntu; rm -rf /')).rejects.toThrow(
      'Invalid distro name'
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
