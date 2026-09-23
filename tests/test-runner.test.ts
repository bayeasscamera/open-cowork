import { describe, expect, it } from 'vitest';
import {
  TEST_COMMANDS,
  isTestCommandId,
  resolveTestCommand,
  runTestCommand,
  supportsTargetedRerun,
  truncateTestOutput,
  type CommandRunner,
} from '../src/main/workspace/test-runner';

function runnerOf(handler: CommandRunner['run']): CommandRunner {
  return { run: handler };
}

describe('test command whitelist', () => {
  it('exposes the known command ids only', () => {
    expect(TEST_COMMANDS.map((spec) => spec.id)).toContain('npm-test');
    expect(isTestCommandId('npm-test')).toBe(true);
    expect(isTestCommandId('rm -rf /')).toBe(false);
    expect(resolveTestCommand('pytest')?.command).toBe('python');
    expect(resolveTestCommand('nope')).toBeNull();
    expect(resolveTestCommand(42)).toBeNull();
  });
});

describe('truncateTestOutput', () => {
  it('keeps the tail of long output', () => {
    const long = 'x'.repeat(50) + 'END';
    const result = truncateTestOutput(long, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(long.slice(-10));
    expect(truncateTestOutput('short', 10)).toEqual({ text: 'short', truncated: false });
  });
});

describe('runTestCommand targeted re-run', () => {
  const okRunner = (seen: string[]): CommandRunner => ({
    run: async (_command, args) => {
      seen.push(...args);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  });

  it('appends the test files after the npm separator', async () => {
    const seen: string[] = [];
    const result = await runTestCommand({
      id: 'npm-test',
      cwd: '/ws',
      filter: ['tests/a.test.ts', 'tests/b.test.ts'],
      runner: okRunner(seen),
    });
    expect(seen).toEqual(['test', '--', 'tests/a.test.ts', 'tests/b.test.ts']);
    expect(result.command).toBe('npm test -- tests/a.test.ts tests/b.test.ts');
    expect(result.filter).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(result.commandId).toBe('npm-test');
  });

  it('appends the files directly for vitest and pytest', async () => {
    for (const id of ['vitest', 'pytest'] as const) {
      const seen: string[] = [];
      await runTestCommand({ id, cwd: '/ws', filter: ['tests/a.test.ts'], runner: okRunner(seen) });
      expect(seen[seen.length - 1]).toBe('tests/a.test.ts');
      expect(seen).not.toContain('--');
    }
  });

  it('drops anything that is not a safe relative test path', async () => {
    const seen: string[] = [];
    await runTestCommand({
      id: 'vitest',
      cwd: '/ws',
      filter: ['/etc/passwd.test.ts', '../evil.test.ts', '--flag', 'tests/ok.test.ts'],
      runner: okRunner(seen),
    });
    expect(seen).toEqual(['vitest', 'run', 'tests/ok.test.ts']);
  });

  it('runs the whole suite when no file survives validation', async () => {
    const seen: string[] = [];
    await runTestCommand({ id: 'vitest', cwd: '/ws', filter: ['nope.txt'], runner: okRunner(seen) });
    expect(seen).toEqual(['vitest', 'run']);
  });

  it('refuses a filter on a command that cannot be narrowed', async () => {
    const result = await runTestCommand({
      id: 'npm-lint',
      cwd: '/ws',
      filter: ['tests/a.test.ts'],
      runner: {
        run: async () => {
          throw new Error('must not run');
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('cannot be narrowed');
    expect(result.commandId).toBe('npm-lint');
  });

  it('exposes which commands support a targeted re-run', () => {
    expect(supportsTargetedRerun('npm-test')).toBe(true);
    expect(supportsTargetedRerun('vitest')).toBe(true);
    expect(supportsTargetedRerun('pytest')).toBe(true);
    expect(supportsTargetedRerun('npm-lint')).toBe(false);
    expect(supportsTargetedRerun('go-test')).toBe(false);
    expect(supportsTargetedRerun('nope')).toBe(false);
  });

  it('records the command id on every result', async () => {
    const result = await runTestCommand({
      id: 'cargo-test',
      cwd: '/ws',
      runner: runnerOf(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
    });
    expect(result.commandId).toBe('cargo-test');
  });
});

describe('runTestCommand', () => {
  it('runs a whitelisted command and reports success', async () => {
    const clock = { value: 1000 };
    const result = await runTestCommand({
      id: 'npm-test',
      cwd: '/ws',
      runner: runnerOf(async (command, args, options) => {
        expect(command).toBe('npm');
        expect(args).toEqual(['test']);
        expect(options.cwd).toBe('/ws');
        return { exitCode: 0, stdout: 'all green', stderr: '', timedOut: false };
      }),
      now: () => clock.value,
      idFactory: () => 'run-1',
    });

    expect(result).toMatchObject({
      id: 'run-1',
      command: 'npm test',
      cwd: '/ws',
      ok: true,
      exitCode: 0,
      stdout: 'all green',
      truncated: false,
    });
  });

  it('reports a failing command as not ok', async () => {
    const result = await runTestCommand({
      id: 'npm-lint',
      cwd: '/ws',
      runner: runnerOf(async () => ({ exitCode: 2, stdout: '', stderr: 'lint error', timedOut: false })),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('lint error');
  });

  it('flags a timeout', async () => {
    const result = await runTestCommand({
      id: 'vitest',
      cwd: '/ws',
      runner: runnerOf(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('Command timed out');
  });

  it('never throws when the runner rejects', async () => {
    const result = await runTestCommand({
      id: 'cargo-test',
      cwd: '/ws',
      runner: runnerOf(async () => {
        throw new Error('cargo not found');
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBe('cargo not found');
  });

  it('refuses an unknown command id', async () => {
    const result = await runTestCommand({
      id: 'rm -rf /' as never,
      cwd: '/ws',
      runner: runnerOf(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Unknown test command');
  });
});
