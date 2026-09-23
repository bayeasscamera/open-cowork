import { describe, expect, it } from 'vitest';
import {
  TEST_COMMANDS,
  isTestCommandId,
  resolveTestCommand,
  runTestCommand,
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
