import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const created: { ssh: unknown[]; daytona: unknown[] } = { ssh: [], daytona: [] };

  const probeResult = { value: true };

  const makeInstance = () => ({
    initialize: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => probeResult.value),
    executeCommand: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => undefined),
    listDirectory: vi.fn(async () => []),
    fileExists: vi.fn(async () => true),
    deleteFile: vi.fn(async () => undefined),
    createDirectory: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  });

  class SshExecutor {
    constructor() {
      Object.assign(this, makeInstance());
      created.ssh.push(this);
    }
  }

  class DaytonaExecutor {
    constructor() {
      Object.assign(this, makeInstance());
      created.daytona.push(this);
    }
  }

  return {
    created,
    SshExecutor,
    DaytonaExecutor,
    probeResult,
    configGet: vi.fn(),
    nativeInitialize: vi.fn(async () => undefined),
  };
});

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) } }));
vi.mock('../src/main/sandbox/ssh-executor', () => ({ SshExecutor: mocks.SshExecutor }));
vi.mock('../src/main/sandbox/daytona-executor', () => ({ DaytonaExecutor: mocks.DaytonaExecutor }));
vi.mock('../src/main/sandbox/native-executor', () => ({
  NativeExecutor: class {
    initialize = mocks.nativeInitialize;
  },
}));
vi.mock('../src/main/config/config-store', () => ({
  configStore: { get: mocks.configGet, set: vi.fn() },
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  SandboxAdapter,
  resolveRemoteSandboxConfig,
} from '../src/main/sandbox/sandbox-adapter';

const base = { workspacePath: '/tmp/ws' };

describe('resolveRemoteSandboxConfig', () => {
  it('rejects ssh mode when COWORK_SSH_HOST is missing', () => {
    const result = resolveRemoteSandboxConfig('ssh', base, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('COWORK_SSH_HOST');
  });

  it('builds a minimal ssh config from host only', () => {
    const result = resolveRemoteSandboxConfig('ssh', base, { COWORK_SSH_HOST: 'box.example' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toMatchObject({
        host: 'box.example',
        workspacePath: '/tmp/ws',
        remoteWorkspacePath: '/tmp/ws',
      });
      expect(result.config).not.toHaveProperty('port');
      expect(result.config).not.toHaveProperty('user');
      expect(result.config).not.toHaveProperty('keyPath');
    }
  });

  it('maps the full ssh env surface and trims whitespace', () => {
    const result = resolveRemoteSandboxConfig('ssh', base, {
      COWORK_SSH_HOST: '  box.example ',
      COWORK_SSH_PORT: '2222',
      COWORK_SSH_USER: ' deploy ',
      COWORK_SSH_KEY_PATH: ' /keys/id_ed25519 ',
      COWORK_SSH_REMOTE_WORKSPACE: ' /srv/cowork ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toMatchObject({
        host: 'box.example',
        port: 2222,
        user: 'deploy',
        keyPath: '/keys/id_ed25519',
        remoteWorkspacePath: '/srv/cowork',
      });
    }
  });

  it('rejects daytona mode when COWORK_DAYTONA_WORKSPACE_ID is missing', () => {
    const result = resolveRemoteSandboxConfig('daytona', base, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('COWORK_DAYTONA_WORKSPACE_ID');
  });

  it('builds a daytona config from env', () => {
    const result = resolveRemoteSandboxConfig('daytona', base, {
      COWORK_DAYTONA_WORKSPACE_ID: 'ws-123',
      COWORK_DAYTONA_API_KEY: 'secret-key',
      COWORK_DAYTONA_API_URL: 'https://api.daytona.io',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toMatchObject({
        workspaceId: 'ws-123',
        apiKey: 'secret-key',
        apiUrl: 'https://api.daytona.io',
      });
    }
  });
});

describe('SandboxAdapter remote dispatch', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mocks.created.ssh.length = 0;
    mocks.created.daytona.length = 0;
    mocks.probeResult.value = true;
    mocks.nativeInitialize.mockClear();
    mocks.configGet.mockImplementation((key: string) => {
      if (key === 'sandboxEnabled') return true;
      if (key === 'sandboxRemoteMode') return 'off';
      return undefined;
    });
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses the SSH executor when sandboxRemoteMode is ssh and env is valid', async () => {
    mocks.configGet.mockImplementation((key: string) =>
      key === 'sandboxEnabled' ? true : key === 'sandboxRemoteMode' ? 'ssh' : undefined
    );
    process.env.COWORK_SSH_HOST = 'box.example';

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws', forceNative: true });

    expect(adapter.mode).toBe('ssh');
    expect(mocks.created.ssh).toHaveLength(1);
    expect(mocks.created.daytona).toHaveLength(0);
    expect(mocks.nativeInitialize).not.toHaveBeenCalled();
  });

  it('uses the Daytona executor when sandboxRemoteMode is daytona', async () => {
    mocks.configGet.mockImplementation((key: string) =>
      key === 'sandboxEnabled' ? true : key === 'sandboxRemoteMode' ? 'daytona' : undefined
    );
    process.env.COWORK_DAYTONA_WORKSPACE_ID = 'ws-123';

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws', forceNative: true });

    expect(adapter.mode).toBe('daytona');
    expect(mocks.created.daytona).toHaveLength(1);
    expect(mocks.nativeInitialize).not.toHaveBeenCalled();
  });

  it('falls back to native when remote env is missing', async () => {
    mocks.configGet.mockImplementation((key: string) =>
      key === 'sandboxEnabled' ? true : key === 'sandboxRemoteMode' ? 'ssh' : undefined
    );
    delete process.env.COWORK_SSH_HOST;

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws', forceNative: true });

    expect(adapter.mode).toBe('native');
    expect(mocks.created.ssh).toHaveLength(0);
    expect(mocks.nativeInitialize).toHaveBeenCalled();
  });

  it('falls back to native when the SSH probe fails', async () => {
    mocks.configGet.mockImplementation((key: string) =>
      key === 'sandboxEnabled' ? true : key === 'sandboxRemoteMode' ? 'ssh' : undefined
    );
    process.env.COWORK_SSH_HOST = 'box.example';
    mocks.probeResult.value = false;

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws', forceNative: true });

    expect(adapter.mode).toBe('native');
    expect(mocks.nativeInitialize).toHaveBeenCalled();
  });

  it('ignores remote mode when sandbox is disabled', async () => {
    mocks.configGet.mockImplementation((key: string) =>
      key === 'sandboxEnabled' ? false : key === 'sandboxRemoteMode' ? 'ssh' : undefined
    );
    process.env.COWORK_SSH_HOST = 'box.example';

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws', forceNative: true });

    expect(adapter.mode).toBe('native');
    expect(mocks.created.ssh).toHaveLength(0);
  });
});
