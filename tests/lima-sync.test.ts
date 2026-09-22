import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeExecFileImpl } from './sandbox-bridge-harness';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { LimaSync } from '../src/main/sandbox/lima-sync';

type RouteResult = { stdout?: string; stderr?: string } | Error;

const routeExec = (routes: Array<[string, RouteResult]>): void => {
  mocks.execFile.mockImplementation(
    makeExecFileImpl((command, args) => {
      const full = [command, ...args].join(' ');
      for (const [needle, result] of routes) {
        if (full.includes(needle)) return result;
      }
      return new Error('unexpected exec: ' + full);
    })
  );
};

const fullCommands = (): string[] =>
  mocks.execFile.mock.calls.map((call) => {
    const [command, args] = call as [string, string[]];
    return [command, ...(Array.isArray(args) ? args : [])].join(' ');
  });

const READY_ROUTES: Array<[string, RouteResult]> = [
  ['cd ~ && pwd', { stdout: '/home/user\n' }],
  ['mkdir -p', { stdout: '' }],
  ['rsync -av --delete', { stdout: 'sent\n' }],
  ['wc -l', { stdout: '7\n' }],
  ['du -sb', { stdout: '2048\n' }],
];

const initSession = async (): Promise<void> => {
  routeExec(READY_ROUTES);
  await LimaSync.initSync('/Users/me/proj', 's1');
};

beforeEach(() => {
  LimaSync.clearAllSessions();
});

describe('LimaSync validation', () => {
  it('rejects session ids that could escape the sandbox root', async () => {
    await expect(LimaSync.initSync('/Users/me/proj', '../evil')).rejects.toThrow('Invalid sessionId');
  });
});

describe('LimaSync.initSync', () => {
  it('copies the workspace into the Lima sandbox and records the session', async () => {
    routeExec(READY_ROUTES);

    const result = await LimaSync.initSync('/Users/me/proj', 's1');

    expect(result).toEqual({
      success: true,
      sandboxPath: '/home/user/.claude/sandbox/s1',
      fileCount: 7,
      totalSize: 2048,
    });
    expect(LimaSync.hasSession('s1')).toBe(true);
    expect(LimaSync.getSandboxPath('s1')).toBe('/home/user/.claude/sandbox/s1');

    const rsync = fullCommands().find((command) => command.includes('rsync -av --delete'));
    expect(rsync).toContain('limactl shell claude-sandbox -- bash -c');
    expect(rsync).not.toContain('source ~/.nvm');
    expect(rsync).toContain("'/Users/me/proj/'");
    expect(rsync).toContain("'/home/user/.claude/sandbox/s1/'");
  });

  it('reuses an initialized session without re-copying', async () => {
    await initSession();
    routeExec([...READY_ROUTES, ['test -d', { stdout: '' }]]);
    const callsAfterInit = mocks.execFile.mock.calls.length;

    const result = await LimaSync.initSync('/Users/me/proj', 's1');

    expect(result.success).toBe(true);
    expect(mocks.execFile.mock.calls.length).toBe(callsAfterInit + 1);
    expect(fullCommands().pop()).toContain('test -d');
  });

  it('reinitializes when the sandbox was deleted externally', async () => {
    await initSession();
    routeExec([...READY_ROUTES, ['test -d', new Error('not found')]]);

    const result = await LimaSync.initSync('/Users/me/proj', 's1');

    expect(result.success).toBe(true);
    expect(fullCommands().filter((c) => c.includes('rsync -av --delete'))).toHaveLength(2);
  });

  it('falls back to /home/user when the home probe returns nothing', async () => {
    routeExec([['cd ~ && pwd', { stdout: '' }], ...READY_ROUTES.slice(1)]);
    const result = await LimaSync.initSync('/Users/me/proj', 's1');
    expect(result.sandboxPath).toBe('/home/user/.claude/sandbox/s1');
  });

  it('reports a failed copy instead of throwing', async () => {
    routeExec([['cd ~ && pwd', { stdout: '/home/user\n' }], ['mkdir -p', new Error('lima down')]]);

    const result = await LimaSync.initSync('/Users/me/proj', 's1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('lima down');
    expect(LimaSync.hasSession('s1')).toBe(false);
  });
});

describe('LimaSync.syncToMac', () => {
  it('fails cleanly when the session is unknown', async () => {
    const result = await LimaSync.syncToMac('missing');
    expect(result).toEqual({
      success: false,
      sandboxPath: '',
      fileCount: 0,
      totalSize: 0,
      error: 'Session not found',
    });
  });

  it('copies sandbox changes back to the mounted macOS path', async () => {
    await initSession();
    routeExec([['rsync -av --delete', { stdout: '' }]]);

    const result = await LimaSync.syncToMac('s1');

    expect(result).toMatchObject({ success: true, fileCount: 7, totalSize: 2048 });
    const rsync = fullCommands().pop();
    expect(rsync).toContain("'/home/user/.claude/sandbox/s1/'");
    expect(rsync).toContain("'/Users/me/proj/'");
  });

  it('reports rsync failures with the session path intact', async () => {
    await initSession();
    routeExec([['rsync -av --delete', new Error('rsync exploded')]]);

    const result = await LimaSync.syncToMac('s1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('rsync exploded');
    expect(result.sandboxPath).toBe('/home/user/.claude/sandbox/s1');
  });
});

describe('LimaSync.cleanup', () => {
  it('syncs back, verifies realpath and deletes the sandbox', async () => {
    await initSession();
    routeExec([
      ['rsync -av --delete', { stdout: '' }],
      ['realpath', { stdout: '/home/user/.claude/sandbox/s1\n' }],
      ['rm -rf', { stdout: '' }],
    ]);

    await LimaSync.cleanup('s1');

    expect(fullCommands().some((command) => command.includes('rm -rf'))).toBe(true);
    expect(LimaSync.hasSession('s1')).toBe(false);
  });

  it('refuses to delete when realpath escapes the sandbox root', async () => {
    await initSession();
    routeExec([
      ['rsync -av --delete', { stdout: '' }],
      ['realpath', { stdout: '/Users/me\n' }],
    ]);

    await LimaSync.cleanup('s1');

    expect(fullCommands().some((command) => command.includes('rm -rf'))).toBe(false);
    expect(LimaSync.hasSession('s1')).toBe(false);
  });

  it('drops the session even when the probe fails', async () => {
    await initSession();
    routeExec([
      ['rsync -av --delete', { stdout: '' }],
      ['realpath', new Error('no such dir')],
    ]);

    await LimaSync.cleanup('s1');

    expect(LimaSync.hasSession('s1')).toBe(false);
  });

  it('ignores unknown sessions', async () => {
    routeExec([]);
    await expect(LimaSync.cleanup('missing')).resolves.toBeUndefined();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe('LimaSync.syncFileToSandbox', () => {
  it('copies one attachment into the sandbox', async () => {
    await initSession();
    routeExec([
      ['mkdir -p', { stdout: '' }],
      ['cp ', { stdout: '' }],
    ]);

    const result = await LimaSync.syncFileToSandbox('s1', '/Users/me/proj/notes.md', 'notes.md');

    expect(result).toEqual({
      success: true,
      sandboxPath: '/home/user/.claude/sandbox/s1/notes.md',
    });
    const cp = fullCommands().find((command) => command.includes(' cp '));
    expect(cp).toContain("'/Users/me/proj/notes.md'");
  });

  it('rejects path traversal in the destination', async () => {
    await initSession();
    routeExec([]);

    const result = await LimaSync.syncFileToSandbox('s1', '/Users/me/x', '../../etc/passwd');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Path traversal detected');
  });

  it('fails for an unknown session', async () => {
    const result = await LimaSync.syncFileToSandbox('missing', '/tmp/a', 'a');
    expect(result).toEqual({ success: false, sandboxPath: '', error: 'Session not found' });
  });

  it('exposes the deprecated boolean copyFileToSandbox alias', async () => {
    await initSession();
    routeExec([
      ['mkdir -p', { stdout: '' }],
      ['cp ', { stdout: '' }],
    ]);

    await expect(LimaSync.copyFileToSandbox('s1', '/Users/me/proj/a.ts', 'a.ts')).resolves.toBe(true);
    await expect(LimaSync.copyFileToSandbox('missing', '/tmp/a', 'a')).resolves.toBe(false);
  });
});

describe('LimaSync session registry', () => {
  it('exposes and clears active sessions', async () => {
    await initSession();
    expect(LimaSync.getAllSessionIds()).toEqual(['s1']);
    expect(LimaSync.getSession('s1')?.initialized).toBe(true);

    LimaSync.clearSession('s1');
    expect(LimaSync.hasSession('s1')).toBe(false);

    await initSession();
    LimaSync.clearAllSessions();
    expect(LimaSync.getAllSessionIds()).toEqual([]);
  });

  it('cleans every active session', async () => {
    await initSession();
    routeExec([
      ['rsync -av --delete', { stdout: '' }],
      ['realpath', { stdout: '/home/user/.claude/sandbox/s1\n' }],
      ['rm -rf', { stdout: '' }],
    ]);

    await LimaSync.cleanupAllSessions();

    expect(LimaSync.getAllSessionIds()).toEqual([]);
  });

  it('is a no-op when nothing is active', async () => {
    routeExec([]);
    await LimaSync.cleanupAllSessions();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('maps paths in both directions', async () => {
    await initSession();

    expect(LimaSync.isPathInSandbox('/home/user/.claude/sandbox/s1/a.ts', 's1')).toBe(true);
    expect(LimaSync.isPathInSandbox('/Users/me/elsewhere/a.ts', 's1')).toBe(false);
    expect(LimaSync.isPathInSandbox('/home/user/.claude/sandbox/s1/a.ts', 'missing')).toBe(false);

    expect(LimaSync.macToSandboxPath('/Users/me/proj/src/a.ts', 's1')).toBe(
      '/home/user/.claude/sandbox/s1/src/a.ts'
    );
    expect(LimaSync.macToSandboxPath('/Users/me/other/a.ts', 's1')).toBeNull();

    expect(LimaSync.sandboxToMacPath('/home/user/.claude/sandbox/s1/src/a.ts', 's1')).toBe(
      '/Users/me/proj/src/a.ts'
    );
    expect(LimaSync.sandboxToMacPath('/home/user/elsewhere/a.ts', 's1')).toBeNull();
    expect(LimaSync.macToSandboxPath('/Users/me/proj/a.ts', 'missing')).toBeNull();
  });
});

describe('LimaSync helpers', () => {
  it('formats byte sizes with its own precision', () => {
    const format = (bytes: number): string =>
      (LimaSync as unknown as { formatSize(bytes: number): string }).formatSize(bytes);
    expect(format(0)).toBe('0 B');
    expect(format(1536)).toBe('1.50 KB');
    expect(format(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});
