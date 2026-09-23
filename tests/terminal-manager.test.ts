import { describe, expect, it } from 'vitest';
import {
  MAX_CHUNK_CHARS,
  MAX_WRITE_CHARS,
  TerminalManager,
  defaultShell,
  isAcceptableShell,
  type TerminalChildProcess,
  type TerminalSpawn,
} from '../src/main/workspace/terminal-manager';

interface FakeChild extends TerminalChildProcess {
  written: string[];
  killCount: number;
  emit(event: string, ...args: unknown[]): void;
  emitStdout(chunk: unknown): void;
  emitStderr(chunk: unknown): void;
}

function createFakeChild(): FakeChild {
  const processListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const stdoutListeners = new Map<string, ((chunk: unknown) => void)[]>();
  const stderrListeners = new Map<string, ((chunk: unknown) => void)[]>();
  const written: string[] = [];

  const subscribe = <T>(map: Map<string, T[]>, event: string, listener: T): void => {
    const list = map.get(event) ?? [];
    list.push(listener);
    map.set(event, list);
  };

  const child: FakeChild = {
    pid: 4242,
    written,
    killCount: 0,
    stdin: {
      write(data: string) {
        written.push(data);
        return true;
      },
    },
    stdout: {
      on(event: string, listener: (chunk: unknown) => void) {
        subscribe(stdoutListeners, event, listener);
        return child;
      },
    },
    stderr: {
      on(event: string, listener: (chunk: unknown) => void) {
        subscribe(stderrListeners, event, listener);
        return child;
      },
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      subscribe(processListeners, event, listener);
      return child;
    },
    kill() {
      child.killCount += 1;
      return true;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of processListeners.get(event) ?? []) {
        listener(...args);
      }
    },
    emitStdout(chunk: unknown) {
      for (const listener of stdoutListeners.get('data') ?? []) {
        listener(chunk);
      }
    },
    emitStderr(chunk: unknown) {
      for (const listener of stderrListeners.get('data') ?? []) {
        listener(chunk);
      }
    },
  };

  return child;
}

interface Harness {
  manager: TerminalManager;
  children: FakeChild[];
  spawnCalls: { command: string; args: readonly string[]; cwd: string }[];
}

function createHarness(overrides: { maxTerminals?: number; maxChunks?: number; shell?: string } = {}) {
  const children: FakeChild[] = [];
  const spawnCalls: { command: string; args: readonly string[]; cwd: string }[] = [];
  let counter = 0;
  const spawn: TerminalSpawn = (command, args, options) => {
    spawnCalls.push({ command, args, cwd: options.cwd });
    const child = createFakeChild();
    children.push(child);
    return child;
  };
  const manager = new TerminalManager({
    spawn,
    isDirectory: (candidate) => candidate === '/ws',
    idFactory: () => 'term-' + (counter += 1),
    now: () => 1000 + counter,
    shell: '/bin/bash',
    ...overrides,
  });
  return { manager, children, spawnCalls };
}

describe('isAcceptableShell', () => {
  it('accepts an absolute path', () => {
    expect(isAcceptableShell('/bin/bash')).toBe(true);
    expect(isAcceptableShell('/usr/local/bin/zsh')).toBe(true);
  });

  it('accepts a bare executable name', () => {
    expect(isAcceptableShell('bash')).toBe(true);
    expect(isAcceptableShell('cmd.exe')).toBe(true);
    expect(isAcceptableShell('pwsh')).toBe(true);
  });

  it('rejects strings that could smuggle extra arguments', () => {
    for (const unsafe of [
      'bash -c',
      'bash;rm -rf /',
      'bash|cat',
      'bash&',
      'bash$(whoami)',
      'bash>out',
      'bash"x"',
      "bash'x'",
      'bash\\x',
      'bash' + String.fromCharCode(96) + 'x' + String.fromCharCode(96),
      'bash\nrm',
    ]) {
      expect(isAcceptableShell(unsafe)).toBe(false);
    }
  });

  it('rejects empty and oversized candidates', () => {
    expect(isAcceptableShell('')).toBe(false);
    expect(isAcceptableShell('   ')).toBe(false);
    expect(isAcceptableShell('/' + 'a'.repeat(600))).toBe(false);
  });
});

describe('defaultShell', () => {
  it('always returns a non-empty shell string', () => {
    expect(defaultShell().trim().length).toBeGreaterThan(0);
  });
});

describe('TerminalManager.open', () => {
  it('spawns the shell with no arguments inside the working directory', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });

    expect(harness.spawnCalls).toEqual([{ command: '/bin/bash', args: [], cwd: '/ws' }]);
    expect(snapshot.session.id).toBe('term-1');
    expect(snapshot.session.sessionId).toBe('s1');
    expect(snapshot.session.cwd).toBe('/ws');
    expect(snapshot.session.shell).toBe('/bin/bash');
    expect(snapshot.session.running).toBe(true);
    expect(snapshot.session.exitCode).toBeNull();
    expect(snapshot.output).toEqual([]);
    expect(snapshot.truncated).toBe(false);
    expect(harness.manager.size()).toBe(1);
  });

  it('honours an explicit shell when it is safe', () => {
    const harness = createHarness();
    harness.manager.open({ sessionId: 's1', cwd: '/ws', shell: '/bin/zsh' });
    expect(harness.spawnCalls[0].command).toBe('/bin/zsh');
  });

  it('rejects an unsafe shell without spawning anything', () => {
    const harness = createHarness();
    expect(() => harness.manager.open({ sessionId: 's1', cwd: '/ws', shell: 'bash -c rm' })).toThrow(
      /Unsupported shell/
    );
    expect(harness.spawnCalls).toEqual([]);
  });

  it('validates the session id and the working directory', () => {
    const harness = createHarness();
    expect(() => harness.manager.open({ sessionId: '', cwd: '/ws' })).toThrow(/session id is required/);
    expect(() => harness.manager.open({ sessionId: 's1', cwd: '' })).toThrow(
      /working directory is required/
    );
    expect(() => harness.manager.open({ sessionId: 's1', cwd: '/missing' })).toThrow(
      /Working directory does not exist/
    );
    expect(harness.spawnCalls).toEqual([]);
  });

  it('caps the number of concurrent terminals', () => {
    const harness = createHarness({ maxTerminals: 2 });
    harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    expect(() => harness.manager.open({ sessionId: 's1', cwd: '/ws' })).toThrow(
      /Too many open terminals/
    );
  });
});

describe('TerminalManager output', () => {
  it('separates stdout from stderr and decodes buffers', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    const child = harness.children[0];

    child.emitStdout('hello\n');
    child.emitStderr(Buffer.from('bad\n', 'utf8'));

    const next = harness.manager.snapshot('s1', snapshot.session.id, 0);
    expect(next.output.map((chunk) => [chunk.stream, chunk.text])).toEqual([
      ['stdout', 'hello\n'],
      ['stderr', 'bad\n'],
    ]);
    expect(next.output.map((chunk) => chunk.seq)).toEqual([1, 2]);
  });

  it('returns only chunks newer than the requested sequence', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    const child = harness.children[0];
    child.emitStdout('one');
    child.emitStdout('two');

    const incremental = harness.manager.snapshot('s1', snapshot.session.id, 1);
    expect(incremental.output.map((chunk) => chunk.text)).toEqual(['two']);
  });

  it('splits very large chunks into bounded pieces', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.children[0].emitStdout('x'.repeat(MAX_CHUNK_CHARS + 5));

    const next = harness.manager.snapshot('s1', snapshot.session.id, 0);
    expect(next.output).toHaveLength(2);
    expect(next.output[0].text).toHaveLength(MAX_CHUNK_CHARS);
    expect(next.output[1].text).toHaveLength(5);
  });

  it('drops the oldest chunks past the buffer bound and reports it', () => {
    const harness = createHarness({ maxChunks: 2 });
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    const child = harness.children[0];
    child.emitStdout('a');
    child.emitStdout('b');
    child.emitStdout('c');

    const next = harness.manager.snapshot('s1', snapshot.session.id, 0);
    expect(next.output.map((chunk) => chunk.text)).toEqual(['b', 'c']);
    expect(next.truncated).toBe(true);
    expect(next.droppedChunks).toBe(1);
  });

  it('ignores empty chunks', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.children[0].emitStdout('');
    expect(harness.manager.snapshot('s1', snapshot.session.id, 0).output).toEqual([]);
  });
});

describe('TerminalManager.write', () => {
  it('appends a newline when the input does not end with one', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.manager.write('s1', snapshot.session.id, 'ls');
    expect(harness.children[0].written).toEqual(['ls\n']);
  });

  it('does not double the newline', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.manager.write('s1', snapshot.session.id, 'ls\n');
    expect(harness.children[0].written).toEqual(['ls\n']);
  });

  it('rejects oversized and non-string input', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    expect(() => harness.manager.write('s1', snapshot.session.id, 'a'.repeat(MAX_WRITE_CHARS + 1))).toThrow(
      /too long/
    );
    expect(() =>
      harness.manager.write('s1', snapshot.session.id, undefined as unknown as string)
    ).toThrow(/must be a string/);
    expect(harness.children[0].written).toEqual([]);
  });

  it('refuses to write to an exited terminal', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.children[0].emit('exit', 0);
    expect(() => harness.manager.write('s1', snapshot.session.id, 'ls')).toThrow(/not running/);
  });
});

describe('TerminalManager scoping', () => {
  it('never lets one session read or drive another session terminal', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    expect(() => harness.manager.snapshot('s2', snapshot.session.id, 0)).toThrow(/Unknown terminal/);
    expect(() => harness.manager.write('s2', snapshot.session.id, 'ls')).toThrow(/Unknown terminal/);
    expect(() => harness.manager.close('s2', snapshot.session.id)).toThrow(/Unknown terminal/);
  });

  it('rejects an unknown terminal id', () => {
    const harness = createHarness();
    expect(() => harness.manager.snapshot('s1', 'nope', 0)).toThrow(/Unknown terminal/);
  });

  it('lists only the terminals of the requested session', () => {
    const harness = createHarness();
    harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.manager.open({ sessionId: 's2', cwd: '/ws' });
    expect(harness.manager.list('s1').map((info) => info.sessionId)).toEqual(['s1']);
    expect(harness.manager.list()).toHaveLength(2);
  });
});

describe('TerminalManager lifecycle', () => {
  it('marks the terminal as exited with its code', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.children[0].emit('exit', 130);

    const next = harness.manager.snapshot('s1', snapshot.session.id, 0);
    expect(next.session.running).toBe(false);
    expect(next.session.exitCode).toBe(130);
    expect(next.session.endedAt).not.toBeUndefined();
  });

  it('records spawn errors as stderr and stops the terminal', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.children[0].emit('error', new Error('spawn ENOENT'));

    const next = harness.manager.snapshot('s1', snapshot.session.id, 0);
    expect(next.output.map((chunk) => chunk.text)).toEqual(['spawn ENOENT']);
    expect(next.session.running).toBe(false);
  });

  it('clears the buffer without killing the process', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.children[0].emitStdout('a');
    harness.children[0].emitStdout('b');

    expect(harness.manager.clear('s1', snapshot.session.id)).toBe(2);
    const next = harness.manager.snapshot('s1', snapshot.session.id, 0);
    expect(next.output).toEqual([]);
    expect(next.truncated).toBe(false);
    expect(next.session.running).toBe(true);
    expect(harness.children[0].killCount).toBe(0);
  });

  it('kills the child when the terminal is closed', () => {
    const harness = createHarness();
    const snapshot = harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    expect(harness.manager.close('s1', snapshot.session.id)).toBe(true);
    expect(harness.children[0].killCount).toBe(1);
    expect(harness.manager.size()).toBe(0);
  });

  it('kills every terminal on closeAll', () => {
    const harness = createHarness();
    harness.manager.open({ sessionId: 's1', cwd: '/ws' });
    harness.manager.open({ sessionId: 's2', cwd: '/ws' });
    expect(harness.manager.closeAll()).toBe(2);
    expect(harness.children.map((child) => child.killCount)).toEqual([1, 1]);
    expect(harness.manager.size()).toBe(0);
  });
});
