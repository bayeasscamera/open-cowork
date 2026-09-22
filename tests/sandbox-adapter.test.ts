import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const created: Record<string, Record<string, ReturnType<typeof vi.fn>>[]> = { wsl: [], lima: [] };

  const makeInstance = () => ({
    initialize: vi.fn(async () => undefined),
    executeCommand: vi.fn(async () => ({ success: true, stdout: 'out', stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => 'file-body'),
    writeFile: vi.fn(async () => undefined),
    listDirectory: vi.fn(async () => []),
    fileExists: vi.fn(async () => true),
    deleteFile: vi.fn(async () => undefined),
    createDirectory: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    runClaudeCode: vi.fn(() =>
      (async function* () {
        yield 'msg';
      })()
    ),
  });

  class WSLBridge {
    static checkWSLStatus = vi.fn();
    static installNodeInWSL = vi.fn();
    static installPythonInWSL = vi.fn();
    static installSkillDependencies = vi.fn();
    constructor() {
      Object.assign(this, makeInstance());
      created.wsl.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>);
    }
  }

  class LimaBridge {
    static checkLimaStatus = vi.fn();
    static createLimaInstance = vi.fn();
    static startLimaInstance = vi.fn();
    static stopLimaInstance = vi.fn();
    static installNodeInLima = vi.fn();
    static installPythonInLima = vi.fn();
    static installSkillDependencies = vi.fn();
    constructor() {
      Object.assign(this, makeInstance());
      created.lima.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>);
    }
  }

  return {
    created,
    WSLBridge,
    LimaBridge,
    pathConverter: { toWSL: (p: string) => 'wsl:' + p, toWindows: (p: string) => 'win:' + p },
    limaPathConverter: { toWSL: (p: string) => 'lima:' + p, toWindows: (p: string) => p },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    configGet: vi.fn(),
    configSet: vi.fn(),
    bootstrap: {
      getCachedWSLStatus: vi.fn(),
      getCachedLimaStatus: vi.fn(),
      reset: vi.fn(),
    },
    nativeInitialize: vi.fn(async () => undefined),
    nativeExecute: vi.fn(async () => ({
      success: true,
      stdout: 'native',
      stderr: '',
      exitCode: 0,
    })),
  };
});

vi.mock('electron', () => ({ dialog: mocks.dialog }));
vi.mock('../src/main/sandbox/wsl-bridge', () => ({
  WSLBridge: mocks.WSLBridge,
  pathConverter: mocks.pathConverter,
}));
vi.mock('../src/main/sandbox/lima-bridge', () => ({
  LimaBridge: mocks.LimaBridge,
  limaPathConverter: mocks.limaPathConverter,
}));
vi.mock('../src/main/sandbox/native-executor', () => ({
  NativeExecutor: class {
    initialize = mocks.nativeInitialize;
    executeCommand = mocks.nativeExecute;
  },
}));
vi.mock('../src/main/sandbox/sandbox-bootstrap', () => ({
  getSandboxBootstrap: () => mocks.bootstrap,
}));
vi.mock('../src/main/config/config-store', () => ({
  configStore: { get: mocks.configGet, set: mocks.configSet },
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { SandboxAdapter } from '../src/main/sandbox/sandbox-adapter';

const originalPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

const WSL_READY = {
  available: true,
  distro: 'Ubuntu-22.04',
  nodeAvailable: true,
  pythonAvailable: true,
  pipAvailable: true,
  claudeCodeAvailable: true,
};

const LIMA_READY = {
  available: true,
  instanceExists: true,
  instanceRunning: true,
  instanceName: 'claude-sandbox',
  nodeAvailable: true,
  pythonAvailable: true,
};

beforeEach(() => {
  mocks.created.wsl.length = 0;
  mocks.created.lima.length = 0;
  mocks.configGet.mockReturnValue(true);
  mocks.bootstrap.getCachedWSLStatus.mockReturnValue(null);
  mocks.bootstrap.getCachedLimaStatus.mockReturnValue(null);
  mocks.WSLBridge.checkWSLStatus.mockResolvedValue({ available: false });
  mocks.LimaBridge.checkLimaStatus.mockResolvedValue({ available: false });
  mocks.WSLBridge.installNodeInWSL.mockResolvedValue(true);
  mocks.WSLBridge.installPythonInWSL.mockResolvedValue(true);
  mocks.LimaBridge.installNodeInLima.mockResolvedValue(true);
  mocks.LimaBridge.installPythonInLima.mockResolvedValue(true);
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('SandboxAdapter mode resolution', () => {
  it('uses native mode when the sandbox is disabled by configuration', async () => {
    setPlatform('darwin');
    mocks.configGet.mockReturnValue(false);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws' });

    expect(adapter.mode).toBe('native');
    expect(adapter.initialized).toBe(true);
    expect(adapter.isWSL).toBe(false);
    expect(adapter.isLima).toBe(false);
    expect(mocks.nativeInitialize).toHaveBeenCalledTimes(1);
    expect(mocks.LimaBridge.checkLimaStatus).not.toHaveBeenCalled();
  });

  it('uses native mode on Linux', async () => {
    setPlatform('linux');
    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws' });
    expect(adapter.mode).toBe('native');
  });

  it('honours forceNative on Windows', async () => {
    setPlatform('win32');
    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: 'D:\\ws', forceNative: true });
    expect(adapter.mode).toBe('native');
    expect(mocks.WSLBridge.checkWSLStatus).not.toHaveBeenCalled();
  });

  it('selects WSL on Windows when the distro is ready', async () => {
    setPlatform('win32');
    mocks.bootstrap.getCachedWSLStatus.mockReturnValue(WSL_READY);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: 'D:\\ws' });

    expect(adapter.mode).toBe('wsl');
    expect(adapter.isWSL).toBe(true);
    expect(adapter.initialized).toBe(true);
    expect(adapter.wslStatus).toEqual(WSL_READY);
    expect(mocks.created.wsl).toHaveLength(1);
    expect(mocks.created.wsl[0].initialize).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: 'D:\\ws' })
    );
  });

  it('falls back to native when WSL is unavailable', async () => {
    setPlatform('win32');
    mocks.bootstrap.getCachedWSLStatus.mockReturnValue({ available: false });

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: 'D:\\ws' });

    expect(adapter.mode).toBe('native');
    expect(mocks.created.wsl).toHaveLength(0);
    expect(mocks.nativeInitialize).toHaveBeenCalledTimes(1);
  });

  it('selects Lima on macOS when the instance is running', async () => {
    setPlatform('darwin');
    mocks.bootstrap.getCachedLimaStatus.mockReturnValue(LIMA_READY);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/Users/me/proj' });

    expect(adapter.mode).toBe('lima');
    expect(adapter.isLima).toBe(true);
    expect(adapter.limaStatus).toEqual(LIMA_READY);
    expect(mocks.created.lima).toHaveLength(1);
  });

  it('falls back to native when Lima is unavailable', async () => {
    setPlatform('darwin');
    mocks.bootstrap.getCachedLimaStatus.mockReturnValue({ available: false });

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/Users/me/proj' });

    expect(adapter.mode).toBe('native');
    expect(mocks.created.lima).toHaveLength(0);
  });

  it('initializes only once even when called concurrently', async () => {
    setPlatform('win32');
    mocks.bootstrap.getCachedWSLStatus.mockReturnValue(WSL_READY);

    const adapter = new SandboxAdapter();
    await Promise.all([
      adapter.initialize({ workspacePath: 'D:\\ws' }),
      adapter.initialize({ workspacePath: 'D:\\ws' }),
    ]);

    expect(mocks.created.wsl).toHaveLength(1);
  });
});

describe('SandboxAdapter executor delegation', () => {
  it('refuses to execute before initialization', async () => {
    const adapter = new SandboxAdapter();
    await expect(adapter.executeCommand('ls')).rejects.toThrow('Sandbox not initialized');
    await expect(adapter.readFile('/tmp/x')).rejects.toThrow('Sandbox not initialized');
  });

  it('forwards the executor surface to the selected bridge', async () => {
    setPlatform('win32');
    mocks.bootstrap.getCachedWSLStatus.mockReturnValue(WSL_READY);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: 'D:\\ws' });
    const bridge = mocks.created.wsl[0];

    await expect(adapter.executeCommand('ls', 'D:\\ws')).resolves.toMatchObject({
      stdout: 'out',
    });
    await expect(adapter.readFile('D:\\ws\\a.txt')).resolves.toBe('file-body');
    await adapter.writeFile('D:\\ws\\b.txt', 'content');
    await expect(adapter.fileExists('D:\\ws\\b.txt')).resolves.toBe(true);
    await adapter.deleteFile('D:\\ws\\b.txt');
    await adapter.createDirectory('D:\\ws\\dir');
    await adapter.copyFile('a', 'b');
    await expect(adapter.listDirectory('D:\\ws')).resolves.toEqual([]);

    expect(bridge.executeCommand).toHaveBeenCalledWith('ls', 'D:\\ws', undefined);
    expect(bridge.writeFile).toHaveBeenCalledWith('D:\\ws\\b.txt', 'content');
    expect(bridge.copyFile).toHaveBeenCalledWith('a', 'b');
  });

  it('streams claude-code through the Lima bridge', async () => {
    setPlatform('darwin');
    mocks.bootstrap.getCachedLimaStatus.mockReturnValue(LIMA_READY);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/Users/me/proj' });

    const messages: unknown[] = [];
    for await (const message of await adapter.runClaudeCode('hi')) {
      messages.push(message);
    }
    expect(messages).toEqual(['msg']);
  });

  it('rejects claude-code in native mode', async () => {
    setPlatform('linux');
    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws' });
    await expect(adapter.runClaudeCode('hi')).rejects.toThrow(
      'Claude Code execution is only supported in WSL/Lima mode'
    );
  });

  it('shuts the executor down and resets the state', async () => {
    setPlatform('win32');
    mocks.bootstrap.getCachedWSLStatus.mockReturnValue(WSL_READY);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: 'D:\\ws' });
    const bridge = mocks.created.wsl[0];

    await adapter.shutdown();

    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(adapter.mode).toBe('none');
    expect(adapter.initialized).toBe(false);
    await expect(adapter.executeCommand('ls')).rejects.toThrow('Sandbox not initialized');
  });
});

describe('SandboxAdapter path utilities', () => {
  it('uses the WSL converter in wsl mode', async () => {
    setPlatform('win32');
    mocks.bootstrap.getCachedWSLStatus.mockReturnValue(WSL_READY);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: 'D:\\ws' });

    expect(adapter.getPathConverter()).toBe(mocks.pathConverter);
    expect(adapter.resolvePath('D:\\ws')).toBe('wsl:D:\\ws');
    expect(adapter.unresolveResultPath('/mnt/d/ws')).toBe('win:/mnt/d/ws');
  });

  it('uses the Lima converter in lima mode', async () => {
    setPlatform('darwin');
    mocks.bootstrap.getCachedLimaStatus.mockReturnValue(LIMA_READY);

    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/Users/me/proj' });

    expect(adapter.getPathConverter()).toBe(mocks.limaPathConverter);
    expect(adapter.resolvePath('/Users/me/proj')).toBe('lima:/Users/me/proj');
    expect(adapter.unresolveResultPath('/Users/me/proj')).toBe('/Users/me/proj');
  });

  it('leaves paths untouched in native mode', async () => {
    setPlatform('linux');
    const adapter = new SandboxAdapter();
    await adapter.initialize({ workspacePath: '/tmp/ws' });

    expect(adapter.getPathConverter()).toBe(mocks.pathConverter);
    expect(adapter.resolvePath('/tmp/ws')).toBe('/tmp/ws');
    expect(adapter.unresolveResultPath('/tmp/ws')).toBe('/tmp/ws');
  });
});
