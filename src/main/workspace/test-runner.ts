/**
 * @module main/workspace/test-runner
 *
 * Cowork 4.0 — Phase 6: running the project's own checks from the control center.
 * Only whitelisted command ids can run: the renderer never sends a raw shell
 * command. A targeted re-run may narrow a whitelisted command to test files,
 * but only files that already look like relative test paths inside the
 * workspace (see shared/test-failures), never a free-form argument.
 */

import { execFile } from 'node:child_process';
import type { TestCommandId, TestRunResult } from '../../shared/control-center-types';
import { isRerunnableTestPath } from '../../shared/test-failures';

export interface TestCommandSpec {
  id: TestCommandId;
  label: string;
  command: string;
  args: string[];
  /**
   * 'append' when the command accepts explicit test files at the end of its
   * arguments; 'unsupported' when it can only run the whole suite.
   */
  filterMode: 'append' | 'unsupported';
  /** Arguments inserted before the file list, e.g. the '--' npm separator. */
  filterPrefix?: string[];
}

export const TEST_COMMANDS: readonly TestCommandSpec[] = [
  {
    id: 'npm-test',
    label: 'npm test',
    command: 'npm',
    args: ['test'],
    filterMode: 'append',
    filterPrefix: ['--'],
  },
  {
    id: 'npm-typecheck',
    label: 'npm run typecheck',
    command: 'npm',
    args: ['run', 'typecheck'],
    filterMode: 'unsupported',
  },
  {
    id: 'npm-lint',
    label: 'npm run lint',
    command: 'npm',
    args: ['run', 'lint'],
    filterMode: 'unsupported',
  },
  { id: 'vitest', label: 'npx vitest run', command: 'npx', args: ['vitest', 'run'], filterMode: 'append' },
  { id: 'pytest', label: 'python -m pytest', command: 'python', args: ['-m', 'pytest'], filterMode: 'append' },
  { id: 'go-test', label: 'go test ./...', command: 'go', args: ['test', './...'], filterMode: 'unsupported' },
  { id: 'cargo-test', label: 'cargo test', command: 'cargo', args: ['test'], filterMode: 'unsupported' },
];

export const DEFAULT_TEST_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_CHARS = 20_000;

export function isTestCommandId(value: unknown): value is TestCommandId {
  return typeof value === 'string' && TEST_COMMANDS.some((spec) => spec.id === value);
}

export function resolveTestCommand(id: unknown): TestCommandSpec | null {
  if (typeof id !== 'string') {
    return null;
  }
  return TEST_COMMANDS.find((spec) => spec.id === id) ?? null;
}

/** True when a command can be narrowed to specific test files. */
export function supportsTargetedRerun(id: unknown): boolean {
  return resolveTestCommand(id)?.filterMode === 'append';
}

export interface CommandRunOptions {
  cwd: string;
  timeoutMs: number;
}

export interface CommandRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRunner {
  run(command: string, args: string[], options: CommandRunOptions): Promise<CommandRunResult>;
}

/** Real runner: never rejects, reports timeouts and spawn failures as results. */
export function createExecFileRunner(): CommandRunner {
  return {
    run(command, args, options) {
      return new Promise<CommandRunResult>((resolve) => {
        execFile(
          command,
          args,
          {
            cwd: options.cwd,
            timeout: options.timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, CI: '1' },
          },
          (error, stdout, stderr) => {
            const details = error as { code?: unknown; killed?: boolean; signal?: string } | null;
            const timedOut = Boolean(details?.killed) || details?.signal === 'SIGTERM';
            const exitCode =
              error && typeof details?.code === 'number' ? (details.code as number) : error ? 1 : 0;
            resolve({
              exitCode,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              timedOut,
            });
          }
        );
      });
    },
  };
}

export function truncateTestOutput(
  text: string,
  maxChars: number = MAX_OUTPUT_CHARS
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(text.length - maxChars), truncated: true };
}

function defaultTestId(): string {
  return 'test-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export interface RunTestCommandInput {
  id: TestCommandId;
  cwd: string;
  runner: CommandRunner;
  /** Test files to narrow the command to; rejected unless they look safe. */
  filter?: readonly string[];
  timeoutMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

export async function runTestCommand(input: RunTestCommandInput): Promise<TestRunResult> {
  const now = input.now ?? (() => Date.now());
  const idFactory = input.idFactory ?? defaultTestId;
  const spec = resolveTestCommand(input.id);
  const startedAt = now();

  if (!spec) {
    return {
      id: idFactory(),
      commandId: input.id,
      command: String(input.id),
      cwd: input.cwd,
      ok: false,
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: 'Unknown test command: ' + String(input.id),
      truncated: false,
      ranAt: startedAt,
    };
  }

  const requested = Array.isArray(input.filter) ? input.filter.filter(isRerunnableTestPath) : [];
  if (requested.length > 0 && spec.filterMode !== 'append') {
    return {
      id: idFactory(),
      commandId: spec.id,
      command: [spec.command, ...spec.args].join(' '),
      cwd: input.cwd,
      ok: false,
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: 'This command cannot be narrowed to specific test files.',
      truncated: false,
      ranAt: startedAt,
    };
  }

  const args =
    requested.length > 0
      ? [...spec.args, ...(spec.filterPrefix ?? []), ...requested]
      : spec.args;
  const commandLine = [spec.command, ...args].join(' ');
  const timeoutMs = Math.max(1000, input.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);

  try {
    const result = await input.runner.run(spec.command, args, { cwd: input.cwd, timeoutMs });
    const stdout = truncateTestOutput(result.stdout);
    const stderr = truncateTestOutput(result.stderr);
    const finishedAt = now();
    return {
      id: idFactory(),
      commandId: spec.id,
      command: commandLine,
      cwd: input.cwd,
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      durationMs: Math.max(0, finishedAt - startedAt),
      stdout: stdout.text,
      stderr: result.timedOut ? stderr.text || 'Command timed out' : stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      ranAt: finishedAt,
      ...(requested.length > 0 ? { filter: requested } : {}),
    };
  } catch (error: unknown) {
    const finishedAt = now();
    return {
      id: idFactory(),
      commandId: spec.id,
      command: commandLine,
      cwd: input.cwd,
      ok: false,
      exitCode: null,
      durationMs: Math.max(0, finishedAt - startedAt),
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      truncated: false,
      ranAt: finishedAt,
      ...(requested.length > 0 ? { filter: requested } : {}),
    };
  }
}
