/**
 * Tests for the sandbox session bootstrap extracted from CoworkAgentRunner.run().
 *
 * The module must stay Electron-free and VM-free: every platform effect is
 * injected, so these tests drive the real orchestration with command execution,
 * filesystem and sync backends mocked out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  hasSession: vi.fn(),
  initSync: vi.fn(),
  limaHasSession: vi.fn(),
  limaInitSync: vi.fn(),
  syncToWindows: vi.fn(),
  syncToMac: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('fs', () => ({ existsSync: mocks.existsSync, mkdirSync: mocks.mkdirSync }));
vi.mock('../src/main/utils/logger', () => ({ log: mocks.log, logError: mocks.logError }));
vi.mock('../src/main/sandbox/sandbox-sync', () => ({
  SandboxSync: {
    hasSession: mocks.hasSession,
    initSync: mocks.initSync,
    syncToWindows: mocks.syncToWindows,
  },
}));
vi.mock('../src/main/sandbox/lima-sync', () => ({
  LimaSync: {
    hasSession: mocks.limaHasSession,
    initSync: mocks.limaInitSync,
    syncToMac: mocks.syncToMac,
  },
}));

import {
  initSandboxSession,
  resolveSandboxBackend,
  syncSandboxChangesToHost,
  type SandboxBackSyncDeps,
  type SandboxSessionInitDeps,
} from '../src/main/agent/agent-runner-sandbox-session';
import type { SandboxSyncStatus } from '../src/shared/types';

const WSL_RESULT = {
  success: true,
  sandboxPath: '/home/u/workspace',
  fileCount: 12,
  totalSize: 2048,
};
const VM_SYNC_OK = { success: true, sandboxPath: '/vm/workspace', fileCount: 0, totalSize: 0 };
const LIMA_RESULT = {
  success: true,
  sandboxPath: '/lima/workspace',
  fileCount: 3,
  totalSize: 512,
};

interface Harness {
  deps: SandboxSessionInitDeps;
  notify: ReturnType<typeof vi.fn>;
  syncUserSkills: ReturnType<typeof vi.fn>;
  syncConfiguredSkills: ReturnType<typeof vi.fn>;
  toVmPath: ReturnType<typeof vi.fn>;
}

const buildHarness = (over: Partial<SandboxSessionInitDeps> = {}): Harness => {
  const notify = vi.fn();
  const syncUserSkills = vi.fn();
  const syncConfiguredSkills = vi.fn();
  const toVmPath = vi.fn((hostPath: string) => `/mnt/c${hostPath}`);
  const deps: SandboxSessionInitDeps = {
    sessionId: 'session-1',
    workingDir: '/host/project',
    backend: { kind: 'wsl', distro: 'Ubuntu' },
    getBuiltinSkillsPath: () => '/app/builtin/skills',
    getRuntimeSkillsDir: () => '/app/runtime/skills',
    syncUserSkills,
    syncConfiguredSkills,
    toVmPath,
    notify,
    ...over,
  };
  return { deps, notify, syncUserSkills, syncConfiguredSkills, toVmPath };
};

/** Flattened VM command lines, e.g. "wsl -d Ubuntu -e mkdir -p /tmp/x". */
const commands = (): string[] =>
  mocks.execFileSync.mock.calls.map((call) => {
    const [file, args] = call as [string, string[]];
    return [file, ...args].join(' ');
  });

/** Timeouts passed to each VM command, in invocation order. */
const timeouts = (): number[] =>
  mocks.execFileSync.mock.calls.map((call) => (call[2] as { timeout: number }).timeout);

const phases = (notify: ReturnType<typeof vi.fn>): string[] =>
  notify.mock.calls.map((call) => (call[0] as SandboxSyncStatus).phase);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(true);
  mocks.hasSession.mockReturnValue(false);
  mocks.limaHasSession.mockReturnValue(false);
  mocks.initSync.mockResolvedValue(WSL_RESULT);
  mocks.limaInitSync.mockResolvedValue(LIMA_RESULT);
  mocks.syncToWindows.mockResolvedValue(VM_SYNC_OK);
  mocks.syncToMac.mockResolvedValue(VM_SYNC_OK);
  mocks.execFileSync.mockImplementation((_file: string, args: string[]) =>
    args.includes('ls') ? 'skill-a\nskill-b\n' : ''
  );
});

describe('resolveSandboxBackend', () => {
  it('selects WSL when the distro is ready and a working directory exists', () => {
    expect(
      resolveSandboxBackend({
        isWsl: true,
        wslDistro: 'Ubuntu',
        isLima: false,
        hasWorkingDir: true,
      })
    ).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });

  it('selects Lima when the instance is running and a working directory exists', () => {
    expect(
      resolveSandboxBackend({
        isWsl: false,
        isLima: true,
        limaInstanceRunning: true,
        hasWorkingDir: true,
      })
    ).toEqual({ kind: 'lima' });
  });

  it('stays off without a working directory', () => {
    expect(
      resolveSandboxBackend({
        isWsl: true,
        wslDistro: 'Ubuntu',
        isLima: true,
        limaInstanceRunning: true,
        hasWorkingDir: false,
      })
    ).toEqual({ kind: 'none' });
  });

  it('stays off while the WSL distro is unknown', () => {
    expect(
      resolveSandboxBackend({ isWsl: true, isLima: false, hasWorkingDir: true })
    ).toEqual({ kind: 'none' });
  });

  it('stays off while the Lima instance is stopped', () => {
    expect(
      resolveSandboxBackend({
        isWsl: false,
        isLima: true,
        limaInstanceRunning: false,
        hasWorkingDir: true,
      })
    ).toEqual({ kind: 'none' });
  });

  it('prefers WSL when both backends report ready', () => {
    expect(
      resolveSandboxBackend({
        isWsl: true,
        wslDistro: 'Ubuntu',
        isLima: true,
        limaInstanceRunning: true,
        hasWorkingDir: true,
      })
    ).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });
});

describe('initSandboxSession', () => {
  it('does no work when no sandbox backend is active', async () => {
    const h = buildHarness({ backend: { kind: 'none' } });

    await expect(initSandboxSession(h.deps)).resolves.toEqual({
      sandboxPath: null,
      useSandboxIsolation: false,
    });
    expect(mocks.initSync).not.toHaveBeenCalled();
    expect(mocks.limaInitSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('does no work when the session has no working directory', async () => {
    const h = buildHarness({ workingDir: undefined });

    await expect(initSandboxSession(h.deps)).resolves.toEqual({
      sandboxPath: null,
      useSandboxIsolation: false,
    });
    expect(mocks.initSync).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('syncs the workspace and skills through WSL and reports progress', async () => {
    const h = buildHarness();

    const result = await initSandboxSession(h.deps);

    expect(result).toEqual({ sandboxPath: '/home/u/workspace', useSandboxIsolation: true });
    expect(mocks.hasSession).toHaveBeenCalledWith('session-1');
    expect(mocks.initSync).toHaveBeenCalledWith('/host/project', 'session-1', 'Ubuntu');
    expect(phases(h.notify)).toEqual(['syncing_files', 'syncing_skills', 'ready']);
    expect(commands()).toEqual([
      'wsl -d Ubuntu -e mkdir -p /home/u/workspace/.claude/skills',
      'wsl -d Ubuntu -e rsync -av /mnt/c/app/builtin/skills/ /home/u/workspace/.claude/skills/',
      'wsl -d Ubuntu -e rsync -avL /mnt/c/app/runtime/skills/ /home/u/workspace/.claude/skills/',
      'wsl -d Ubuntu -e ls /home/u/workspace/.claude/skills',
    ]);
  });

  it('gives short commands 10s and rsync 2 minutes', async () => {
    const h = buildHarness();

    await initSandboxSession(h.deps);

    expect(timeouts()).toEqual([10000, 120000, 120000, 10000]);
  });

  it('materialises user and configured skills into the runtime directory', async () => {
    const h = buildHarness();

    await initSandboxSession(h.deps);

    expect(h.syncUserSkills).toHaveBeenCalledWith('/app/runtime/skills');
    expect(h.syncConfiguredSkills).toHaveBeenCalledWith('/app/runtime/skills');
  });

  it('creates the runtime skills directory when it is missing', async () => {
    const h = buildHarness();
    mocks.existsSync.mockReturnValue(false);

    await initSandboxSession(h.deps);

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/app/runtime/skills', { recursive: true });
  });

  it('skips the built-in rsync when the built-in skills directory is missing', async () => {
    const h = buildHarness();
    mocks.existsSync.mockImplementation((target: string) => target !== '/app/builtin/skills');

    await initSandboxSession(h.deps);

    expect(commands().some((command) => command.includes('/app/builtin/skills'))).toBe(false);
    expect(commands().some((command) => command.includes('rsync -avL'))).toBe(true);
  });

  it('skips the built-in rsync when the built-in skills path is empty', async () => {
    const h = buildHarness({ getBuiltinSkillsPath: () => '' });

    await initSandboxSession(h.deps);

    expect(commands().some((command) => command.includes('rsync -av '))).toBe(false);
    expect(commands().some((command) => command.includes('rsync -avL'))).toBe(true);
  });

  it('syncs without progress events for an already-synced session', async () => {
    const h = buildHarness();
    mocks.hasSession.mockReturnValue(true);

    const result = await initSandboxSession(h.deps);

    expect(result.useSandboxIsolation).toBe(true);
    expect(h.notify).not.toHaveBeenCalled();
    expect(mocks.initSync).toHaveBeenCalledWith('/host/project', 'session-1', 'Ubuntu');
    expect(commands().some((command) => command.includes('mkdir -p'))).toBe(true);
  });

  it('reports a failed sync and falls back to direct host access', async () => {
    const h = buildHarness();
    mocks.initSync.mockResolvedValue({
      success: false,
      sandboxPath: '',
      fileCount: 0,
      totalSize: 0,
      error: 'rsync exploded',
    });

    const result = await initSandboxSession(h.deps);

    expect(result).toEqual({ sandboxPath: null, useSandboxIsolation: false });
    expect(phases(h.notify)).toEqual(['syncing_files', 'error']);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('stays silent when a re-sync fails in an existing session', async () => {
    const h = buildHarness();
    mocks.hasSession.mockReturnValue(true);
    mocks.initSync.mockResolvedValue({
      success: false,
      sandboxPath: '',
      fileCount: 0,
      totalSize: 0,
      error: 'still broken',
    });

    const result = await initSandboxSession(h.deps);

    expect(result).toEqual({ sandboxPath: null, useSandboxIsolation: false });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('keeps the run alive when copying skills fails', async () => {
    const h = buildHarness();
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('vm unreachable');
    });

    const result = await initSandboxSession(h.deps);

    expect(result).toEqual({ sandboxPath: '/home/u/workspace', useSandboxIsolation: true });
    expect(phases(h.notify)).toEqual(['syncing_files', 'syncing_skills', 'ready']);
  });

  it('uses the Lima launcher and host paths in Lima mode', async () => {
    const h = buildHarness({ backend: { kind: 'lima' } });

    const result = await initSandboxSession(h.deps);

    expect(result).toEqual({ sandboxPath: '/lima/workspace', useSandboxIsolation: true });
    expect(mocks.limaInitSync).toHaveBeenCalledWith('/host/project', 'session-1');
    expect(mocks.initSync).not.toHaveBeenCalled();
    expect(commands()).toEqual([
      'limactl shell claude-sandbox -- mkdir -p /lima/workspace/.claude/skills',
      'limactl shell claude-sandbox -- rsync -av /app/builtin/skills/ /lima/workspace/.claude/skills/',
      'limactl shell claude-sandbox -- rsync -avL /app/runtime/skills/ /lima/workspace/.claude/skills/',
      'limactl shell claude-sandbox -- ls /lima/workspace/.claude/skills',
    ]);
    expect(h.toVmPath).not.toHaveBeenCalled();
  });

  it('keeps Lima progress events on a Lima failure', async () => {
    const h = buildHarness({ backend: { kind: 'lima' } });
    mocks.limaInitSync.mockResolvedValue({
      success: false,
      sandboxPath: '',
      fileCount: 0,
      totalSize: 0,
      error: 'nope',
    });

    await initSandboxSession(h.deps);

    expect(phases(h.notify)).toEqual(['syncing_files', 'error']);
    expect(mocks.initSync).not.toHaveBeenCalled();
  });
});

describe('syncSandboxChangesToHost', () => {
  interface BackSyncHarness {
    deps: SandboxBackSyncDeps;
    onWarning: ReturnType<typeof vi.fn>;
    getPlatform: ReturnType<typeof vi.fn>;
  }

  const buildBackSync = (over: Partial<SandboxBackSyncDeps> = {}): BackSyncHarness => {
    const onWarning = vi.fn();
    const getPlatform = vi.fn(() => ({ isWsl: true, isLima: false }));
    const deps: SandboxBackSyncDeps = {
      sessionId: 'session-1',
      useSandboxIsolation: true,
      sandboxPath: '/home/u/workspace',
      getPlatform,
      onWarning,
      ...over,
    };
    return { deps, onWarning, getPlatform };
  };

  it('does nothing when the run was not isolated', async () => {
    const h = buildBackSync({ useSandboxIsolation: false });

    await syncSandboxChangesToHost(h.deps);

    expect(h.getPlatform).not.toHaveBeenCalled();
    expect(mocks.syncToWindows).not.toHaveBeenCalled();
    expect(h.onWarning).not.toHaveBeenCalled();
  });

  it('does nothing without a sandbox path', async () => {
    const h = buildBackSync({ sandboxPath: null });

    await syncSandboxChangesToHost(h.deps);

    expect(h.getPlatform).not.toHaveBeenCalled();
    expect(mocks.syncToWindows).not.toHaveBeenCalled();
  });

  it('syncs the sandbox back to Windows in WSL mode', async () => {
    const h = buildBackSync();

    await syncSandboxChangesToHost(h.deps);

    expect(mocks.syncToWindows).toHaveBeenCalledWith('session-1');
    expect(mocks.syncToMac).not.toHaveBeenCalled();
    expect(h.onWarning).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Syncing sandbox changes to Windows...'
    );
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Sync completed successfully');
  });

  it('logs a failed Windows sync without warning the user', async () => {
    const h = buildBackSync();
    mocks.syncToWindows.mockResolvedValue({
      success: false,
      sandboxPath: '',
      fileCount: 0,
      totalSize: 0,
      error: 'disk full',
    });

    await syncSandboxChangesToHost(h.deps);

    expect(mocks.logError).toHaveBeenCalledWith('[CoworkAgentRunner] Sync failed:', 'disk full');
    expect(h.onWarning).not.toHaveBeenCalled();
  });

  it('syncs the sandbox back to macOS in Lima mode', async () => {
    const h = buildBackSync({ getPlatform: () => ({ isWsl: false, isLima: true }) });

    await syncSandboxChangesToHost(h.deps);

    expect(mocks.syncToMac).toHaveBeenCalledWith('session-1');
    expect(mocks.syncToWindows).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Syncing sandbox changes to macOS...'
    );
  });

  it('logs a failed macOS sync without warning the user', async () => {
    const h = buildBackSync({ getPlatform: () => ({ isWsl: false, isLima: true }) });
    mocks.syncToMac.mockResolvedValue({
      success: false,
      sandboxPath: '',
      fileCount: 0,
      totalSize: 0,
      error: 'lima down',
    });

    await syncSandboxChangesToHost(h.deps);

    expect(mocks.logError).toHaveBeenCalledWith('[CoworkAgentRunner] Sync failed:', 'lima down');
    expect(h.onWarning).not.toHaveBeenCalled();
  });

  it('prefers WSL when both platforms report active', async () => {
    const h = buildBackSync({ getPlatform: () => ({ isWsl: true, isLima: true }) });

    await syncSandboxChangesToHost(h.deps);

    expect(mocks.syncToWindows).toHaveBeenCalledTimes(1);
    expect(mocks.syncToMac).not.toHaveBeenCalled();
  });

  it('stays silent when no platform is active', async () => {
    const h = buildBackSync({ getPlatform: () => ({ isWsl: false, isLima: false }) });

    await syncSandboxChangesToHost(h.deps);

    expect(mocks.syncToWindows).not.toHaveBeenCalled();
    expect(mocks.syncToMac).not.toHaveBeenCalled();
    expect(h.onWarning).not.toHaveBeenCalled();
  });

  it('turns a thrown sync into a user warning', async () => {
    const h = buildBackSync();
    mocks.syncToWindows.mockRejectedValue(new Error('vm unreachable'));

    await syncSandboxChangesToHost(h.deps);

    expect(h.onWarning).toHaveBeenCalledWith('Sandbox sync failed: vm unreachable');
  });

  it('stringifies a non-Error sync failure', async () => {
    const h = buildBackSync();
    mocks.syncToWindows.mockRejectedValue('plain failure');

    await syncSandboxChangesToHost(h.deps);

    expect(h.onWarning).toHaveBeenCalledWith('Sandbox sync failed: plain failure');
  });

  it('warns when the platform lookup itself fails', async () => {
    const h = buildBackSync({
      getPlatform: () => {
        throw new Error('adapter exploded');
      },
    });

    await syncSandboxChangesToHost(h.deps);

    expect(h.onWarning).toHaveBeenCalledWith('Sandbox sync failed: adapter exploded');
    expect(mocks.syncToWindows).not.toHaveBeenCalled();
  });
});
