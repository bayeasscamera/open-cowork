import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeAgentProcess, makeExecFileImpl, makeExecImpl } from './sandbox-bridge-harness';

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

import { LimaBridge, limaPathConverter } from '../src/main/sandbox/lima-bridge';

interface MutableBridgeState {
  limaProcess: unknown;
  isInitialized: boolean;
  config: unknown;
}

const asState = (bridge: LimaBridge): MutableBridgeState =>
  bridge as unknown as MutableBridgeState;

const newBridgeWithAgent = (
  responder?: ConstructorParameters<typeof FakeAgentProcess>[0]
): { bridge: LimaBridge; fake: FakeAgentProcess } => {
  const fake = new FakeAgentProcess(responder);
  mocks.spawn.mockReturnValue(fake);
  const bridge = new LimaBridge();
  const state = asState(bridge);
  state.limaProcess = fake;
  state.isInitialized = true;
  state.config = { workspacePath: '/Users/me/proj' };
  // Mirror what startAgent() wires up: feed the transport from the fake stdout.
  fake.stdout.on('data', (data: Buffer) => {
    (
      bridge as unknown as { ingestStdout(chunk: Buffer, onOverflow: () => void): void }
    ).ingestStdout(data, () => fake.kill());
  });
  return { bridge, fake };
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Lima path converter', () => {
  it('keeps /Users paths untouched in both directions', () => {
    expect(limaPathConverter.toWSL('/Users/me/proj')).toBe('/Users/me/proj');
    expect(limaPathConverter.toWindows('/Users/me/proj')).toBe('/Users/me/proj');
    expect(limaPathConverter.toWSL('')).toBe('');
    expect(limaPathConverter.toWindows('')).toBe('');
  });

  it('is exposed through getPathConverter', () => {
    const bridge = new LimaBridge();
    expect(bridge.getPathConverter()).toBe(limaPathConverter);
    expect(bridge.initialized).toBe(false);
  });
});

describe('LimaBridge.checkLimaStatus', () => {
  const installResolvers = (
    execRoutes: Record<string, { stdout?: unknown } | Error>,
    execFileRoutes: Record<string, { stdout?: unknown } | Error> = {}
  ): void => {
    mocks.exec.mockImplementation(
      makeExecImpl(
        (command) => execRoutes[command] ?? new Error('unexpected exec: ' + command)
      )
    );
    mocks.execFile.mockImplementation(
      makeExecFileImpl((command, args) => {
        const key = [command, ...args].join(' ');
        return execFileRoutes[key] ?? new Error('unexpected execFile: ' + key);
      })
    );
  };

  it('reports unavailable when limactl is missing', async () => {
    installResolvers({ 'which limactl': new Error('not found') });
    expect(await LimaBridge.checkLimaStatus()).toEqual({ available: false });
  });

  it('stops at instance discovery when the VM is not running', async () => {
    installResolvers({
      'which limactl': { stdout: '/opt/homebrew/bin/limactl' },
      'limactl list': { stdout: 'NAME STATUS\nclaude-sandbox Stopped\n' },
    });

    expect(await LimaBridge.checkLimaStatus()).toEqual({
      available: true,
      instanceExists: true,
      instanceRunning: false,
      instanceName: 'claude-sandbox',
    });
  });

  it('reports the full toolchain when the instance is running', async () => {
    const shell = (script: string): string => 'limactl shell claude-sandbox -- bash -c ' + script;

    installResolvers(
      {
        'which limactl': { stdout: '/opt/homebrew/bin/limactl' },
        'limactl list': { stdout: 'NAME STATUS\nclaude-sandbox Running 127.0.0.1:60022\n' },
      },
      {
        [shell('node --version')]: { stdout: 'v20.11.0\n' },
        [shell('python3 --version')]: { stdout: 'Python 3.11.2\n' },
        [shell('python3 -m pip --version')]: { stdout: 'pip 23.0\n' },
        [shell('bash -c "source ~/.nvm/nvm.sh 2>/dev/null; which claude"')]: {
          stdout: '/usr/local/bin/claude\n',
        },
      }
    );

    const status = await LimaBridge.checkLimaStatus();

    expect(status).toEqual({
      available: true,
      instanceExists: true,
      instanceRunning: true,
      instanceName: 'claude-sandbox',
      nodeAvailable: true,
      pythonAvailable: true,
      pipAvailable: true,
      claudeCodeAvailable: true,
      version: 'v20.11.0',
      pythonVersion: 'Python 3.11.2',
    });
  });

  it('reports an existing stopped instance when limactl list fails', async () => {
    installResolvers({
      'which limactl': { stdout: 'ok' },
      'limactl list': new Error('boom'),
      'limactl info claude-sandbox': { stdout: '{}' },
    });

    expect(await LimaBridge.checkLimaStatus()).toEqual({
      available: true,
      instanceExists: true,
      instanceRunning: false,
      instanceName: 'claude-sandbox',
    });
  });
});

describe('LimaBridge executor protocol', () => {
  it('refuses to execute before initialization', async () => {
    const bridge = new LimaBridge();
    await expect(bridge.executeCommand('ls')).rejects.toThrow('Lima bridge not initialized');
    await expect(bridge.readFile('/tmp/a.txt')).rejects.toThrow('Lima bridge not initialized');
    await expect(bridge.shutdown()).resolves.toBeUndefined();
  });

  it('sends executeCommand without altering the cwd', async () => {
    const { bridge, fake } = newBridgeWithAgent(() => ({
      result: { code: 0, stdout: 'ok', stderr: '' },
    }));

    await expect(bridge.executeCommand('ls -la', '/Users/me/proj')).resolves.toEqual({
      success: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });

    expect(fake.request('executeCommand')?.params).toEqual({
      command: 'ls -la',
      cwd: '/Users/me/proj',
      env: undefined,
    });
  });

  it('passes paths through untouched for the file surface', async () => {
    const { bridge, fake } = newBridgeWithAgent((request) => {
      switch (request.method) {
        case 'readFile':
          return { result: { content: 'file-body' } };
        case 'listDirectory':
          return { result: { entries: [] } };
        case 'fileExists':
          return { result: { exists: true } };
        default:
          return { result: {} };
      }
    });

    await expect(bridge.readFile('/Users/me/a.txt')).resolves.toBe('file-body');
    await expect(bridge.listDirectory('/Users/me/proj')).resolves.toEqual([]);
    await expect(bridge.fileExists('/Users/me/a.txt')).resolves.toBe(true);
    await bridge.writeFile('/Users/me/b.txt', 'content');
    await bridge.deleteFile('/Users/me/c.txt');
    await bridge.createDirectory('/Users/me/dir');
    await bridge.copyFile('/Users/me/a.txt', '/Users/me/d.txt');

    expect(fake.request('writeFile')?.params).toEqual({
      path: '/Users/me/b.txt',
      content: 'content',
    });
    expect(fake.request('deleteFile')?.params).toEqual({ path: '/Users/me/c.txt' });
    expect(fake.request('createDirectory')?.params).toEqual({ path: '/Users/me/dir' });
    expect(fake.request('copyFile')?.params).toEqual({
      src: '/Users/me/a.txt',
      dest: '/Users/me/d.txt',
    });
  });

  it('streams runClaudeCode messages', async () => {
    const { bridge, fake } = newBridgeWithAgent(() => ({
      result: { messages: [{ type: 'assistant' }] },
    }));

    const messages: unknown[] = [];
    for await (const message of await bridge.runClaudeCode('hi', { cwd: '/Users/me/proj' })) {
      messages.push(message);
    }

    expect(messages).toEqual([{ type: 'assistant' }]);
    expect(fake.request('runClaudeCode')?.params).toMatchObject({
      prompt: 'hi',
      cwd: '/Users/me/proj',
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
});

describe('LimaBridge.initialize', () => {
  it('rejects when Lima is not installed', async () => {
    mocks.cachedStatus.value = { available: false };
    mocks.exec.mockImplementation(makeExecImpl(() => new Error('no limactl')));
    const bridge = new LimaBridge();
    await expect(bridge.initialize({ workspacePath: '/Users/me/proj' })).rejects.toThrow(
      'Lima is not installed. Please install with: brew install lima'
    );
  });

  it('spawns the agent through limactl shell and pushes the workspace', async () => {
    vi.useFakeTimers();
    mocks.cachedStatus.value = {
      available: true,
      instanceExists: true,
      instanceRunning: true,
      instanceName: 'claude-sandbox',
      nodeAvailable: true,
      pythonAvailable: true,
      pipAvailable: true,
      claudeCodeAvailable: true,
    };

    const fake = new FakeAgentProcess();
    mocks.spawn.mockReturnValue(fake);

    const bridge = new LimaBridge();
    const pending = bridge.initialize({ workspacePath: '/Users/me/proj', timeout: 1500 });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    const [command, args, options] = mocks.spawn.mock.calls[0] as [string, string[], unknown];
    expect(command).toBe('limactl');
    expect(args.slice(0, 4)).toEqual(['shell', 'claude-sandbox', '--', 'bash']);
    expect(args[4]).toBe('-c');
    expect(args[5]).toContain('node "');
    expect(options).toEqual({ stdio: ['pipe', 'pipe', 'pipe'] });

    expect(fake.request('setWorkspace')?.params).toEqual({
      path: '/Users/me/proj',
      macPath: '/Users/me/proj',
    });
    expect(bridge.initialized).toBe(true);
  });
});
