import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeAgentProcess, makeExecFileImpl } from './sandbox-bridge-harness';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
  cachedStatus: { value: null as unknown },
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  exec: mocks.exec,
  execFile: mocks.execFile,
  ChildProcess: class {},
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('../src/main/sandbox/sandbox-bootstrap', () => ({
  getSandboxBootstrap: () => ({
    getCachedWSLStatus: () => mocks.cachedStatus.value,
    getCachedLimaStatus: () => mocks.cachedStatus.value,
  }),
}));

import { WSLBridge, pathConverter } from '../src/main/sandbox/wsl-bridge';

interface MutableBridgeState {
  wslProcess: unknown;
  isInitialized: boolean;
  config: unknown;
  distro: string;
}

const asState = (bridge: WSLBridge): MutableBridgeState =>
  bridge as unknown as MutableBridgeState;

const attachAgent = (bridge: WSLBridge, fake: FakeAgentProcess, timeout?: number): void => {
  const state = asState(bridge);
  state.wslProcess = fake;
  state.isInitialized = true;
  state.config = { workspacePath: 'D:\\ws', timeout };
  // Mirror what startAgent() wires up: feed the transport from the fake stdout.
  fake.stdout.on('data', (data: Buffer) => {
    (
      bridge as unknown as { ingestStdout(chunk: Buffer, onOverflow: () => void): void }
    ).ingestStdout(data, () => fake.kill());
  });
};

const newBridgeWithAgent = (
  responder?: ConstructorParameters<typeof FakeAgentProcess>[0]
): { bridge: WSLBridge; fake: FakeAgentProcess } => {
  const fake = new FakeAgentProcess(responder);
  mocks.spawn.mockReturnValue(fake);
  const bridge = new WSLBridge();
  attachAgent(bridge, fake);
  return { bridge, fake };
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WSL path converter', () => {
  it('converts Windows drive paths to /mnt paths', () => {
    expect(pathConverter.toWSL('D:\\DeskTop\\project')).toBe('/mnt/d/DeskTop/project');
    expect(pathConverter.toWSL('c:/tmp/x')).toBe('/mnt/c/tmp/x');
  });

  it('normalises relative and empty inputs', () => {
    expect(pathConverter.toWSL('')).toBe('');
    expect(pathConverter.toWSL('/already/unix')).toBe('/already/unix');
    expect(pathConverter.toWSL('relative\\file.txt')).toBe('relative/file.txt');
  });

  it('leaves UNC paths untouched', () => {
    expect(pathConverter.toWSL('\\\\server\\share')).toBe('\\\\server\\share');
  });

  it('converts /mnt paths back to Windows paths', () => {
    expect(pathConverter.toWindows('/mnt/d/DeskTop/project')).toBe('D:\\DeskTop\\project');
    expect(pathConverter.toWindows('/mnt/c')).toBe('C:\\');
    expect(pathConverter.toWindows('/home/user')).toBe('/home/user');
    expect(pathConverter.toWindows('')).toBe('');
  });

  it('is exposed through getPathConverter', () => {
    const bridge = new WSLBridge();
    expect(bridge.getPathConverter()).toBe(pathConverter);
    expect(bridge.initialized).toBe(false);
  });
});

describe('WSLBridge distro validation', () => {
  const validate = (distro: string): string =>
    (WSLBridge as unknown as { validateDistroName(value: string): string }).validateDistroName(
      distro
    );

  it('accepts safe distro names', () => {
    expect(validate('Ubuntu-22.04_x')).toBe('Ubuntu-22.04_x');
  });

  it('rejects shell metacharacters', () => {
    expect(() => validate('Ubuntu; rm -rf /')).toThrow(/Invalid WSL distro name/);
    expect(() => validate('Ubuntu$(id)')).toThrow(/Invalid WSL distro name/);
  });
});

describe('WSLBridge.checkWSLStatus', () => {
  const installResolver = (
    overrides: Record<string, { stdout?: unknown; stderr?: unknown } | Error> = {}
  ): void => {
    const defaults: Record<string, { stdout?: unknown; stderr?: unknown } | Error> = {
      'wsl --status': { stdout: '' },
      'wsl --list --quiet': { stdout: Buffer.from('Ubuntu-22.04\r\n', 'utf16le') },
      'wsl -d Ubuntu-22.04 -e echo OK': { stdout: 'OK' },
      'wsl -d Ubuntu-22.04 -e node --version': { stdout: 'v20.11.0\n' },
      'wsl -d Ubuntu-22.04 -e python3 --version': { stdout: 'Python 3.11.2\n' },
      'wsl -d Ubuntu-22.04 -e python3 -m pip --version': { stdout: 'pip 23.0\n' },
      ...overrides,
    };
    mocks.execFile.mockImplementation(
      makeExecFileImpl((command, args) => {
        const key = [command, ...args].join(' ');
        const route = defaults[key];
        if (!route) return new Error(`unexpected execFile: ${key}`);
        return route;
      })
    );
  };

  it('reports the selected distro and its toolchain', async () => {
    installResolver({
      'wsl -d Ubuntu-22.04 -e bash -c source ~/.nvm/nvm.sh 2>/dev/null; which claude && claude --version':
        { stdout: '/usr/bin/claude\n1.2.3\n' },
    });

    const status = await WSLBridge.checkWSLStatus();

    expect(status).toEqual({
      available: true,
      distro: 'Ubuntu-22.04',
      nodeAvailable: true,
      pythonAvailable: true,
      pipAvailable: true,
      claudeCodeAvailable: true,
      version: 'v20.11.0',
      pythonVersion: 'Python 3.11.2',
    });
  });

  it('tolerates a failing wsl --status probe', async () => {
    installResolver({ 'wsl --status': new Error('unsupported') });
    const status = await WSLBridge.checkWSLStatus();
    expect(status.available).toBe(true);
  });

  it('returns unavailable when no distro is listed', async () => {
    installResolver({ 'wsl --list --quiet': { stdout: Buffer.from('\r\n', 'utf16le') } });
    expect(await WSLBridge.checkWSLStatus()).toEqual({ available: false });
  });

  it('returns unavailable when the distro does not answer', async () => {
    installResolver({ 'wsl -d Ubuntu-22.04 -e echo OK': { stdout: 'KO' } });
    expect(await WSLBridge.checkWSLStatus()).toEqual({ available: false });
  });

  it('returns unavailable when the wsl CLI itself fails', async () => {
    installResolver({ 'wsl --list --quiet': new Error('no wsl') });
    expect(await WSLBridge.checkWSLStatus()).toEqual({ available: false });
  });

  it('falls back to nvm when node is not on PATH', async () => {
    installResolver({
      'wsl -d Ubuntu-22.04 -e node --version': new Error('not found'),
      'wsl -d Ubuntu-22.04 -e bash -c source ~/.nvm/nvm.sh 2>/dev/null && node --version': {
        stdout: 'v18.19.0\n',
      },
    });

    const status = await WSLBridge.checkWSLStatus();
    expect(status.nodeAvailable).toBe(true);
    expect(status.version).toBe('v18.19.0 (nvm)');
  });
});

describe('WSLBridge executor protocol', () => {
  it('refuses to execute before initialization', async () => {
    const bridge = new WSLBridge();
    await expect(bridge.executeCommand('ls')).rejects.toThrow('WSL bridge not initialized');
    await expect(bridge.readFile('D:\\a.txt')).rejects.toThrow('WSL bridge not initialized');
    await expect(bridge.shutdown()).resolves.toBeUndefined();
  });

  it('sends executeCommand with a converted cwd and maps the result', async () => {
    const { bridge, fake } = newBridgeWithAgent(() => ({
      result: { code: 0, stdout: 'ok', stderr: '' },
    }));

    await expect(bridge.executeCommand('ls -la', 'D:\\proj')).resolves.toEqual({
      success: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });

    expect(fake.request('executeCommand')?.params).toEqual({
      command: 'ls -la',
      cwd: '/mnt/d/proj',
      env: undefined,
    });
  });

  it('marks a non-zero exit code as a failure', async () => {
    const { bridge } = newBridgeWithAgent(() => ({ result: { code: 2, stdout: '', stderr: 'nope' } }));
    const result = await bridge.executeCommand('false');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it('converts paths for the whole file/directory surface', async () => {
    const { bridge, fake } = newBridgeWithAgent((request) => {
      switch (request.method) {
        case 'readFile':
          return { result: { content: 'file-body' } };
        case 'listDirectory':
          return { result: { entries: [{ name: 'a', isDirectory: false }] } };
        case 'fileExists':
          return { result: { exists: true } };
        default:
          return { result: {} };
      }
    });

    await expect(bridge.readFile('D:\\proj\\a.txt')).resolves.toBe('file-body');
    await expect(bridge.listDirectory('D:\\proj')).resolves.toEqual([
      { name: 'a', isDirectory: false },
    ]);
    await expect(bridge.fileExists('D:\\proj\\a.txt')).resolves.toBe(true);
    await bridge.writeFile('D:\\proj\\b.txt', 'content');
    await bridge.deleteFile('D:\\proj\\c.txt');
    await bridge.createDirectory('D:\\proj\\dir');
    await bridge.copyFile('D:\\proj\\a.txt', 'D:\\proj\\d.txt');

    expect(fake.request('readFile')?.params).toEqual({ path: '/mnt/d/proj/a.txt' });
    expect(fake.request('writeFile')?.params).toEqual({
      path: '/mnt/d/proj/b.txt',
      content: 'content',
    });
    expect(fake.request('deleteFile')?.params).toEqual({ path: '/mnt/d/proj/c.txt' });
    expect(fake.request('createDirectory')?.params).toEqual({ path: '/mnt/d/proj/dir' });
    expect(fake.request('copyFile')?.params).toEqual({
      src: '/mnt/d/proj/a.txt',
      dest: '/mnt/d/proj/d.txt',
    });
  });

  it('streams runClaudeCode messages with a converted cwd', async () => {
    const { bridge, fake } = newBridgeWithAgent(() => ({
      result: { messages: [{ type: 'assistant' }, { type: 'result' }] },
    }));

    const messages: unknown[] = [];
    for await (const message of await bridge.runClaudeCode('hi', { cwd: 'D:\\proj', maxTurns: 3 })) {
      messages.push(message);
    }

    expect(messages).toEqual([{ type: 'assistant' }, { type: 'result' }]);
    expect(fake.request('runClaudeCode')?.params).toMatchObject({
      prompt: 'hi',
      cwd: '/mnt/d/proj',
      maxTurns: 3,
    });
  });

  it('rejects when the agent answers with a JSON-RPC error', async () => {
    const { bridge } = newBridgeWithAgent(() => ({
      error: { code: -32000, message: 'agent exploded' },
    }));
    await expect(bridge.executeCommand('ls')).rejects.toThrow('agent exploded');
  });

  it('shuts the agent down and clears the initialized flag', async () => {
    const { bridge, fake } = newBridgeWithAgent();
    expect(bridge.initialized).toBe(true);

    await bridge.shutdown();

    expect(fake.request('shutdown')).toBeDefined();
    expect(fake.killed).toBe(true);
    expect(bridge.initialized).toBe(false);
  });

  it('survives a shutdown request that never answers', async () => {
    const { bridge, fake } = newBridgeWithAgent();
    fake.setResponder(() => ({ error: { code: 1, message: 'gone' } }));

    await bridge.shutdown();

    expect(fake.killed).toBe(true);
    expect(bridge.initialized).toBe(false);
  });
});

describe('WSLBridge.initialize', () => {
  it('rejects when WSL is unavailable', async () => {
    mocks.cachedStatus.value = { available: false };
    mocks.execFile.mockImplementation(makeExecFileImpl(() => new Error('no wsl')));
    const bridge = new WSLBridge();
    await expect(bridge.initialize({ workspacePath: 'D:\\ws' })).rejects.toThrow(
      'WSL2 is not available on this system'
    );
  });

  it('spawns the agent in the selected distro and pushes the workspace', async () => {
    vi.useFakeTimers();
    mocks.cachedStatus.value = {
      available: true,
      distro: 'Ubuntu-22.04',
      nodeAvailable: true,
      pythonAvailable: true,
      pipAvailable: true,
      claudeCodeAvailable: true,
    };

    const fake = new FakeAgentProcess();
    mocks.spawn.mockReturnValue(fake);

    const bridge = new WSLBridge();
    const pending = bridge.initialize({ workspacePath: 'D:\\proj', timeout: 1500 });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    const [command, args, options] = mocks.spawn.mock.calls[0] as [string, string[], unknown];
    expect(command).toBe('wsl');
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu-22.04', '--', 'bash']);
    expect(args[4]).toBe('-c');
    expect(args[5]).toContain('node "');
    expect(options).toEqual({ stdio: ['pipe', 'pipe', 'pipe'] });

    expect(fake.methods()).toContain('ping');
    expect(fake.request('setWorkspace')?.params).toEqual({
      path: '/mnt/d/proj',
      windowsPath: 'D:\\proj',
    });
    expect(bridge.initialized).toBe(true);
    expect(bridge.currentDistro).toBe('Ubuntu-22.04');
  });
});
