import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlCenterService } from '../src/main/agent/control-center-service';
import type { CommandRunner } from '../src/main/workspace/test-runner';

let root = '';
const calls: string[][] = [];
let queued: Array<{ exitCode: number; stdout?: string; stderr?: string }> = [];

const runner: CommandRunner = {
  run: async (_command, args) => {
    calls.push([...args]);
    const next = queued.shift() ?? { exitCode: 0 };
    return {
      exitCode: next.exitCode,
      stdout: next.stdout ?? '',
      stderr: next.stderr ?? '',
      timedOut: false,
    };
  },
};

function makeService(): ControlCenterService {
  let counter = 0;
  return new ControlCenterService({
    resolveWorkspaceRoot: (sessionId) => (sessionId === 's1' ? root : null),
    runner,
    idFactory: () => 'run-' + ++counter,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-rerun-'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests', 'a.test.ts'), 'it("a", () => {});\n');
  writeFileSync(join(root, 'tests', 'b.test.ts'), 'it("b", () => {});\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ControlCenterService.rerunFailedTests', () => {
  it('reports no workspace for an unknown session', async () => {
    calls.length = 0;
    queued = [];
    const outcome = await makeService().rerunFailedTests('nope');
    expect(outcome).toEqual({ ran: false, reason: 'no_workspace' });
    expect(calls).toEqual([]);
  });

  it('reports no previous run', async () => {
    calls.length = 0;
    queued = [];
    expect(await makeService().rerunFailedTests('s1')).toEqual({
      ran: false,
      reason: 'no_previous_run',
    });
  });

  it('reports no previous run when the last run passed', async () => {
    calls.length = 0;
    queued = [{ exitCode: 0 }];
    const service = makeService();
    await service.runTests('s1', 'vitest');
    expect(await service.rerunFailedTests('s1')).toEqual({
      ran: false,
      reason: 'no_previous_run',
    });
  });

  it('re-runs only the failed files that exist in the workspace', async () => {
    calls.length = 0;
    queued = [
      {
        exitCode: 1,
        stdout: [
          'FAIL  tests/b.test.ts > b > works',
          'FAIL  tests/a.test.ts > a > works',
          'FAIL  tests/gone.test.ts > removed',
        ].join('\n'),
      },
      { exitCode: 0, stdout: 'all green' },
    ];
    const service = makeService();
    await service.runTests('s1', 'vitest');
    const outcome = await service.rerunFailedTests('s1');

    expect(outcome.ran).toBe(true);
    expect(outcome.files).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(calls[1]).toEqual(['vitest', 'run', 'tests/a.test.ts', 'tests/b.test.ts']);
    expect(outcome.result?.ok).toBe(true);
    expect(outcome.result?.filter).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(service.lastTestResult('s1')?.filter).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('reports no failed file when nothing usable was found', async () => {
    calls.length = 0;
    queued = [{ exitCode: 1, stdout: 'FAIL tests/gone.test.ts > removed' }];
    const service = makeService();
    await service.runTests('s1', 'vitest');
    expect(await service.rerunFailedTests('s1')).toEqual({
      ran: false,
      reason: 'no_failed_files',
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a command that cannot be narrowed', async () => {
    calls.length = 0;
    queued = [{ exitCode: 1, stdout: 'FAIL tests/a.test.ts > a' }];
    const service = makeService();
    await service.runTests('s1', 'npm-lint');
    expect(await service.rerunFailedTests('s1')).toEqual({
      ran: false,
      reason: 'unsupported_command',
    });
    expect(calls).toHaveLength(1);
  });

  it('keeps the failing result when the re-run cannot happen', async () => {
    calls.length = 0;
    queued = [{ exitCode: 2, stdout: 'FAIL tests/gone.test.ts > removed' }];
    const service = makeService();
    await service.runTests('s1', 'npm-test');
    await service.rerunFailedTests('s1');
    expect(service.lastTestResult('s1')?.ok).toBe(false);
    expect(service.lastTestResult('s1')?.exitCode).toBe(2);
  });
});
