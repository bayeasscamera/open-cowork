import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeExecFileImpl } from './sandbox-bridge-harness';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import SandboxSync from '../src/main/sandbox/sandbox-sync';
import { shellEscapePath } from '../src/main/sandbox/sync-helpers';

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
  ['wc -l', { stdout: '12\n' }],
  ['du -sb', { stdout: '4096\n' }],
];

const initSession = async (): Promise<void> => {
  routeExec(READY_ROUTES);
  await SandboxSync.initSync('D:\\proj', 's1', 'Ubuntu-22.04');
};

beforeEach(() => {
  SandboxSync.clearAllSessions();
});

describe('SandboxSync validation', () => {
  it('rejects session ids that could escape the sandbox root', async () => {
    await expect(SandboxSync.initSync('D:\\proj', '../evil', 'Ubuntu')).rejects.toThrow(
      'Invalid sessionId'
    );
    await expect(SandboxSync.initSync('D:\\proj', 'a/b', 'Ubuntu')).rejects.toThrow(
      'Invalid sessionId'
    );
  });

  it('rejects distro names with shell metacharacters', async () => {
    await expect(SandboxSync.initSync('D:\\proj', 's1', 'Ubuntu; rm -rf /')).rejects.toThrow(
      'Invalid distro name'
    );
  });
});

describe('SandboxSync.initSync', () => {
  it('copies the workspace into the WSL sandbox and records the session', async () => {
    routeExec(READY_ROUTES);

    const result = await SandboxSync.initSync('D:\\proj', 's1', 'Ubuntu-22.04');

    expect(result).toEqual({
      success: true,
      sandboxPath: '/home/user/.claude/sandbox/s1',
      fileCount: 12,
      totalSize: 4096,
    });
    expect(SandboxSync.hasSession('s1')).toBe(true);
    expect(SandboxSync.getSandboxPath('s1')).toBe('/home/user/.claude/sandbox/s1');
    expect(SandboxSync.getDistro('s1')).toBe('Ubuntu-22.04');

    const rsync = fullCommands().find((command) => command.includes('rsync -av --delete'));
    expect(rsync).toContain('wsl -d Ubuntu-22.04 -e bash -c');
    expect(rsync).toContain('source ~/.nvm/nvm.sh 2>/dev/null;');
    expect(rsync).toContain("'/mnt/d/proj/'");
    expect(rsync).toContain("'/home/user/.claude/sandbox/s1/'");
  });

  it('reuses an initialized session without re-copying', async () => {
    await initSession();
    routeExec([...READY_ROUTES, ['test -d', { stdout: '' }]]);
    const callsAfterInit = mocks.execFile.mock.calls.length;

    const result = await SandboxSync.initSync('D:\\proj', 's1', 'Ubuntu-22.04');

    expect(result.success).toBe(true);
    expect(mocks.execFile.mock.calls.length).toBe(callsAfterInit + 1);
    expect(fullCommands().pop()).toContain('test -d');
  });

  it('reinitializes when the sandbox was deleted externally', async () => {
    await initSession();
    routeExec([...READY_ROUTES, ['test -d', new Error('not found')]]);

    const result = await SandboxSync.initSync('D:\\proj', 's1', 'Ubuntu-22.04');

    expect(result.success).toBe(true);
    expect(fullCommands().some((command) => command.includes('rsync -av --delete'))).toBe(true);
  });

  it('falls back to /root when the home probe returns nothing', async () => {
    routeExec([['cd ~ && pwd', { stdout: '' }], ...READY_ROUTES.slice(1)]);
    const result = await SandboxSync.initSync('D:\\proj', 's1', 'Ubuntu');
    expect(result.sandboxPath).toBe('/root/.claude/sandbox/s1');
  });

  it('reports a failed copy instead of throwing', async () => {
    routeExec([['cd ~ && pwd', { stdout: '/home/user\n' }], ['mkdir -p', new Error('wsl down')]]);

    const result = await SandboxSync.initSync('D:\\proj', 's1', 'Ubuntu');

    expect(result.success).toBe(false);
    expect(result.error).toContain('wsl down');
    expect(SandboxSync.hasSession('s1')).toBe(false);
  });
});

describe('SandboxSync.syncToWindows', () => {
  it('fails cleanly when the session is unknown', async () => {
    const result = await SandboxSync.syncToWindows('missing');
    expect(result).toEqual({
      success: false,
      sandboxPath: '',
      fileCount: 0,
      totalSize: 0,
      error: 'Session not found',
    });
  });

  it('copies sandbox changes back to the Windows mount', async () => {
    await initSession();
    routeExec([['rsync -av --delete', { stdout: 'sent\n' }]]);

    const result = await SandboxSync.syncToWindows('s1');

    expect(result).toMatchObject({ success: true, fileCount: 12, totalSize: 4096 });
    const rsync = fullCommands().pop();
    expect(rsync).toContain("'/home/user/.claude/sandbox/s1/'");
    expect(rsync).toContain("'/mnt/d/proj/'");
  });

  it('exposes the legacy finalSync alias', async () => {
    await initSession();
    routeExec([['rsync -av --delete', { stdout: '' }]]);
    const result = await SandboxSync.finalSync('s1');
    expect(result.success).toBe(true);
  });

  it('reports rsync failures with the session path intact', async () => {
    await initSession();
    routeExec([['rsync -av --delete', new Error('rsync exploded')]]);

    const result = await SandboxSync.syncToWindows('s1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('rsync exploded');
    expect(result.sandboxPath).toBe('/home/user/.claude/sandbox/s1');
  });
});

describe('SandboxSync.cleanup', () => {
  it('removes the sandbox once realpath confirms it is inside the root', async () => {
    await initSession();
    routeExec([
      ['realpath', { stdout: '/home/user/.claude/sandbox/s1\n' }],
      ['rm -rf', { stdout: '' }],
    ]);

    await SandboxSync.cleanup('s1');

    expect(fullCommands().some((command) => command.includes('rm -rf'))).toBe(true);
    expect(SandboxSync.hasSession('s1')).toBe(false);
  });

  it('refuses to delete when realpath escapes the sandbox root', async () => {
    await initSession();
    routeExec([['realpath', { stdout: '/home/user/.ssh\n' }]]);

    await SandboxSync.cleanup('s1');

    expect(fullCommands().some((command) => command.includes('rm -rf'))).toBe(false);
    expect(SandboxSync.hasSession('s1')).toBe(false);
  });

  it('keeps the session when the probe itself fails', async () => {
    await initSession();
    routeExec([['realpath', new Error('no such dir')]]);

    await SandboxSync.cleanup('s1');

    expect(SandboxSync.hasSession('s1')).toBe(true);
  });

  it('ignores unknown sessions', async () => {
    routeExec([]);
    await expect(SandboxSync.cleanup('missing')).resolves.toBeUndefined();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('syncs before cleaning up on session deletion', async () => {
    await initSession();
    routeExec([
      ['rsync -av --delete', { stdout: '' }],
      ['realpath', { stdout: '/home/user/.claude/sandbox/s1\n' }],
      ['rm -rf', { stdout: '' }],
    ]);

    const result = await SandboxSync.syncAndCleanup('s1');

    expect(result.success).toBe(true);
    expect(SandboxSync.hasSession('s1')).toBe(false);
  });
});

describe('SandboxSync.syncFileToSandbox', () => {
  it('copies one attachment into the sandbox', async () => {
    await initSession();
    routeExec([
      ['mkdir -p', { stdout: '' }],
      ['cp ', { stdout: '' }],
    ]);

    const result = await SandboxSync.syncFileToSandbox(
      's1',
      'D:\\proj\\notes.md',
      'notes.md'
    );

    expect(result).toEqual({
      success: true,
      sandboxPath: '/home/user/.claude/sandbox/s1/notes.md',
    });
    const cp = fullCommands().find((command) => command.includes(' cp '));
    expect(cp).toContain("'/mnt/d/proj/notes.md'");
  });

  it('rejects path traversal in the destination', async () => {
    await initSession();
    const callsBefore = mocks.execFile.mock.calls.length;
    routeExec([]);

    const result = await SandboxSync.syncFileToSandbox('s1', 'D:\\proj\\x', '../../etc/passwd');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Path traversal detected');
    expect(mocks.execFile.mock.calls.length).toBe(callsBefore);
  });

  it('fails for an unknown session', async () => {
    const result = await SandboxSync.syncFileToSandbox('missing', '/tmp/a', 'a');
    expect(result).toEqual({ success: false, sandboxPath: '', error: 'Session not found' });
  });
});

describe('SandboxSync session registry', () => {
  it('exposes and clears active sessions', async () => {
    await initSession();
    expect(SandboxSync.getAllSessionIds()).toEqual(['s1']);
    expect(SandboxSync.getSession('s1')?.initialized).toBe(true);

    SandboxSync.clearSession('s1');
    expect(SandboxSync.hasSession('s1')).toBe(false);

    await initSession();
    SandboxSync.clearAllSessions();
    expect(SandboxSync.getAllSessionIds()).toEqual([]);
  });

  it('cleans every active session in parallel', async () => {
    await initSession();
    routeExec([
      ['rsync -av --delete', { stdout: '' }],
      ['realpath', { stdout: '/home/user/.claude/sandbox/s1\n' }],
      ['rm -rf', { stdout: '' }],
    ]);

    await SandboxSync.cleanupAllSessions();

    expect(SandboxSync.getAllSessionIds()).toEqual([]);
  });

  it('is a no-op when nothing is active', async () => {
    routeExec([]);
    await SandboxSync.cleanupAllSessions();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('maps paths in both directions', async () => {
    await initSession();

    expect(SandboxSync.isPathInSandbox('/home/user/.claude/sandbox/s1/a.ts', 's1')).toBe(true);
    expect(SandboxSync.isPathInSandbox('/home/user/elsewhere/a.ts', 's1')).toBe(false);
    expect(SandboxSync.isPathInSandbox('/home/user/.claude/sandbox/s1/a.ts', 'missing')).toBe(false);

    expect(SandboxSync.windowsToSandboxPath('D:\\proj\\src\\a.ts', 's1')).toBe(
      '/home/user/.claude/sandbox/s1/src/a.ts'
    );
    expect(SandboxSync.windowsToSandboxPath('D:\\other\\a.ts', 's1')).toBeNull();

    expect(SandboxSync.sandboxToWindowsPath('/home/user/.claude/sandbox/s1/src/a.ts', 's1')).toBe(
      'D:\\proj\\src\\a.ts'
    );
    expect(SandboxSync.sandboxToWindowsPath('/home/user/elsewhere/a.ts', 's1')).toBeNull();
    expect(SandboxSync.windowsToSandboxPath('D:\\proj\\a.ts', 'missing')).toBeNull();
  });
});

describe('SandboxSync helpers and shared escaping', () => {
  it('escapes single quotes for POSIX shell interpolation', () => {
    const escape = (value: string): string =>
      shellEscapePath(value);
    expect(escape("a'b")).toBe("a'\\''b");
    expect(escape('/plain/path')).toBe('/plain/path');
  });

  it('formats byte sizes', () => {
    const format = (bytes: number): string =>
      (SandboxSync as unknown as { formatSize(bytes: number): string }).formatSize(bytes);
    expect(format(512)).toBe('512 B');
    expect(format(1536)).toBe('1.5 KB');
    expect(format(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(format(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});
