/**
 * Tests for the bash tool wrappers extracted from CoworkAgentRunner:
 * default-timeout injection and sudo password interception.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  isSudoCommand,
  rewriteSudoCommand,
  runSudoCommand,
  wrapBashToolForSudo,
  wrapBashToolWithDefaultTimeout,
} from '../src/main/agent/agent-runner-bash-tools';

type ExecResult = { content: Array<{ text: string }>; details: unknown };

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);
  written = '';
  stdinEnded = false;
  readonly stdin = {
    write: (chunk: string): void => {
      this.written += chunk;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  finish(stdout = '', stderr = ''): void {
    if (stdout) this.stdout.emit('data', Buffer.from(stdout));
    if (stderr) this.stderr.emit('data', Buffer.from(stderr));
    this.emit('close', 0);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

const makeTool = (name: string, execute: ReturnType<typeof vi.fn>): ToolDefinition =>
  ({ name, description: name, parameters: {}, execute }) as unknown as ToolDefinition;

const passthroughExecute = (): ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ content: [{ type: 'text', text: 'original' }], details: undefined }));

const runTool = (
  tool: ToolDefinition,
  params: { command: string; timeout?: number }
): Promise<ExecResult> => {
  const execute = tool.execute as unknown as (
    id: string,
    p: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown
  ) => Promise<ExecResult>;
  return execute('call-1', params, undefined, undefined, { sessionId: 's1' });
};

let children: FakeChild[] = [];

beforeEach(() => {
  children = [];
  mocks.spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isSudoCommand', () => {
  it('matches a sudo invocation', () => {
    expect(isSudoCommand('sudo apt install -y curl')).toBe(true);
    expect(isSudoCommand('echo hi && sudo rm -rf /tmp/x')).toBe(true);
    expect(isSudoCommand('  sudo -S true')).toBe(true);
  });

  it('does not match sudo as a substring', () => {
    expect(isSudoCommand('visudo')).toBe(false);
    expect(isSudoCommand('sudoku --help')).toBe(false);
    expect(isSudoCommand('ls -la')).toBe(false);
    expect(isSudoCommand('')).toBe(false);
  });
});

describe('rewriteSudoCommand', () => {
  it('adds -S to a plain sudo invocation', () => {
    expect(rewriteSudoCommand('sudo apt install')).toBe('sudo -S apt install');
  });

  it('keeps an existing -S flag', () => {
    expect(rewriteSudoCommand('sudo -S apt install')).toBe('sudo -S apt install');
  });

  it('rewrites every sudo in a compound command', () => {
    expect(rewriteSudoCommand('sudo a && sudo b')).toBe('sudo -S a && sudo -S b');
  });

  it('leaves commands without sudo untouched', () => {
    expect(rewriteSudoCommand('echo sudoers')).toBe('echo sudoers');
  });
});

describe('wrapBashToolWithDefaultTimeout', () => {
  it('leaves non-bash tools untouched', () => {
    const read = makeTool('read', passthroughExecute());
    const wrapped = wrapBashToolWithDefaultTimeout([read]);
    expect(wrapped[0]).toBe(read);
  });

  it('injects the default timeout when the model omits one', async () => {
    const execute = passthroughExecute();
    const wrapped = wrapBashToolWithDefaultTimeout([makeTool('bash', execute)]);

    await runTool(wrapped[0], { command: 'sleep 1' });

    expect(execute).toHaveBeenCalledWith(
      'call-1',
      { command: 'sleep 1', timeout: DEFAULT_BASH_TIMEOUT_SECONDS },
      undefined,
      undefined,
      { sessionId: 's1' }
    );
  });

  it('preserves an explicit timeout, including zero', async () => {
    const execute = passthroughExecute();
    const wrapped = wrapBashToolWithDefaultTimeout([makeTool('bash', execute)]);

    await runTool(wrapped[0], { command: 'a', timeout: 30 });
    await runTool(wrapped[0], { command: 'b', timeout: 0 });

    expect(execute.mock.calls[0][1]).toEqual({ command: 'a', timeout: 30 });
    expect(execute.mock.calls[1][1]).toEqual({ command: 'b', timeout: 0 });
  });

  it('accepts a custom default timeout', async () => {
    const execute = passthroughExecute();
    const wrapped = wrapBashToolWithDefaultTimeout([makeTool('bash', execute)], 5);

    await runTool(wrapped[0], { command: 'a' });

    expect(execute.mock.calls[0][1]).toEqual({ command: 'a', timeout: 5 });
  });
});

describe('wrapBashToolForSudo', () => {
  const options = {
    sessionId: 'session-7',
    effectiveCwd: '/work',
  };

  it('is a no-op when no password requester is configured', () => {
    const tools = [makeTool('bash', passthroughExecute())];
    expect(wrapBashToolForSudo(tools, options)).toBe(tools);
  });

  it('leaves non-bash tools untouched', () => {
    const read = makeTool('read', passthroughExecute());
    const wrapped = wrapBashToolForSudo([read], {
      ...options,
      requestSudoPassword: vi.fn(async () => 'pw'),
    });
    expect(wrapped[0]).toBe(read);
  });

  it('delegates non-sudo commands to the original execute', async () => {
    const execute = passthroughExecute();
    const wrapped = wrapBashToolForSudo([makeTool('bash', execute)], {
      ...options,
      requestSudoPassword: vi.fn(async () => 'pw'),
    });

    const result = await runTool(wrapped[0], { command: 'ls -la' });

    expect(result.content[0].text).toBe('original');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('runs a sudo command with the password piped over stdin', async () => {
    const requestSudoPassword = vi.fn(async () => 's3cret');
    const wrapped = wrapBashToolForSudo([makeTool('bash', passthroughExecute())], {
      ...options,
      requestSudoPassword,
    });
    setImmediate(() => children[0].finish('installed\n', 'warning\n'));

    const result = await runTool(wrapped[0], { command: 'sudo apt install' });

    expect(requestSudoPassword).toHaveBeenCalledWith('session-7', 'call-1', 'sudo apt install');
    expect(result.content[0].text).toBe('installed\nwarning\n');
    const [shell, shellArgs, spawnOptions] = mocks.spawn.mock.calls[0];
    expect(shell).toBe(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    expect(shellArgs).toEqual([process.platform === 'win32' ? '/c' : '-c', 'sudo -S apt install']);
    expect(spawnOptions).toMatchObject({ cwd: '/work', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(children[0].written).toBe('s3cret\n');
    expect(children[0].stdinEnded).toBe(true);
  });

  it('reports (no output) when the sudo command prints nothing', async () => {
    const wrapped = wrapBashToolForSudo([makeTool('bash', passthroughExecute())], {
      ...options,
      requestSudoPassword: vi.fn(async () => 'pw'),
    });
    setImmediate(() => children[0].finish());

    const result = await runTool(wrapped[0], { command: 'sudo true' });

    expect(result.content[0].text).toBe('(no output)');
  });

  it('cancels the command when the user denies the password', async () => {
    const wrapped = wrapBashToolForSudo([makeTool('bash', passthroughExecute())], {
      ...options,
      requestSudoPassword: vi.fn(async () => null),
    });

    const result = await runTool(wrapped[0], { command: 'sudo rm -rf /' });

    expect(result.content[0].text).toBe('Command cancelled: user denied sudo password.');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('surfaces a spawn error as a rejection', async () => {
    const wrapped = wrapBashToolForSudo([makeTool('bash', passthroughExecute())], {
      ...options,
      requestSudoPassword: vi.fn(async () => 'pw'),
    });
    setImmediate(() => children[0].fail(new Error('spawn ENOENT')));

    await expect(runTool(wrapped[0], { command: 'sudo x' })).rejects.toThrow('spawn ENOENT');
  });
});

describe('runSudoCommand', () => {
  const spec = {
    shell: '/bin/sh',
    shellArgs: ['-c', 'sudo -S true'],
    password: 'pw',
    cwd: '/tmp',
    timeoutMs: 5000,
  };

  it('resolves with stdout then stderr', async () => {
    const promise = runSudoCommand(spec);
    children[0].finish('out\n', 'err\n');
    await expect(promise).resolves.toBe('out\nerr\n');
  });

  it('rejects when the child emits an error', async () => {
    const promise = runSudoCommand(spec);
    children[0].fail(new Error('boom'));
    await expect(promise).rejects.toThrow('boom');
  });

  it('kills the child and rejects on timeout', async () => {
    vi.useFakeTimers();
    const promise = runSudoCommand(spec);
    const assertion = expect(promise).rejects.toThrow('timed out after 5000ms');
    vi.advanceTimersByTime(5000);
    await assertion;
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });
});
