import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDetachedLaunchPlan,
  describeDetachedEvent,
  isProcessAlive,
  killDetachedTree,
  parseDetachedResult,
  readDetachedResult,
  readNewLogLines,
  spawnDetachedDelegation,
  type DetachedLaunchPlan,
  type DetachedSpawnFn,
} from '../src/main/agent/detached-delegation';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-detached-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('detached delegation — launch plan', () => {
  it('passes the brief as ONE argv element, never through a shell', () => {
    const plan = buildDetachedLaunchPlan({
      execPath: '/Applications/Open Cowork.app/Contents/MacOS/Open Cowork',
      prompt: 'do x; rm -rf /',
      cwd: '/tmp/ws',
      resultFile: '/tmp/r.json',
      logFile: '/tmp/l.jsonl',
      delegationId: 'bg-1',
      env: { PATH: '/usr/bin' },
    });
    expect(plan.command).toBe('/Applications/Open Cowork.app/Contents/MacOS/Open Cowork');
    expect(plan.args).toEqual([
      '--headless',
      '--mode',
      'json',
      '--cwd',
      '/tmp/ws',
      '-p',
      'do x; rm -rf /',
      '--result-file',
      '/tmp/r.json',
    ]);
    // The dangerous characters stay inside one element, never a separate token.
    expect(plan.args).not.toContain(';');
    expect(plan.args).not.toContain('rm');
  });

  it('prepends the app path in development and adds --auto-approve only when asked', () => {
    const dev = buildDetachedLaunchPlan({
      execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      appPath: '/repo',
      prompt: 'p',
      cwd: '/tmp',
      autoApprove: true,
      resultFile: '/tmp/r.json',
      logFile: '/tmp/l.jsonl',
      env: {},
    });
    expect(dev.args[0]).toBe('/repo');
    expect(dev.args).toContain('--auto-approve');

    const safe = buildDetachedLaunchPlan({
      execPath: '/bin/app',
      prompt: 'p',
      cwd: '/tmp',
      resultFile: '/tmp/r.json',
      logFile: '/tmp/l.jsonl',
      env: {},
    });
    expect(safe.args[0]).toBe('--headless');
    expect(safe.args).not.toContain('--auto-approve');
  });

  it('forces COWORK_MULTI_INSTANCE so the child does not hit the single-instance lock', () => {
    const plan = buildDetachedLaunchPlan({
      execPath: '/bin/app',
      prompt: 'p',
      cwd: '/tmp',
      resultFile: '/tmp/r.json',
      logFile: '/tmp/l.jsonl',
      env: { PATH: '/usr/bin', EMPTY: undefined as unknown as string },
      delegationId: 'bg-9',
    });
    expect(plan.env.COWORK_MULTI_INSTANCE).toBe('1');
    expect(plan.env.COWORK_DETACHED_DELEGATION_ID).toBe('bg-9');
    expect(plan.env.PATH).toBe('/usr/bin');
    expect('EMPTY' in plan.env).toBe(false);
  });
});

describe('detached delegation — result file', () => {
  it('reads a valid atomic result and ignores unusable ones', () => {
    const file = join(tmp(), 'r.json');
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, status: 'completed', output: 'ok', finishedAt: 5 })
    );
    expect(readDetachedResult(file)).toEqual({ status: 'completed', output: 'ok', finishedAt: 5 });
    expect(readDetachedResult(join(tmp(), 'missing.json'))).toBeNull();

    writeFileSync(file, JSON.stringify({ schemaVersion: 99, status: 'completed' }));
    expect(readDetachedResult(file)).toBeNull();
    writeFileSync(file, 'not json');
    expect(readDetachedResult(file)).toBeNull();
    expect(parseDetachedResult({ status: 'weird' })).toBeNull();
    expect(parseDetachedResult(null)).toBeNull();
  });
});

describe('detached delegation — process helpers', () => {
  it('detects a live pid and rejects invalid ones', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it('kills a REAL detached process tree', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid as number;
    expect(isProcessAlive(pid)).toBe(true);
    expect(killDetachedTree(pid, 'SIGTERM')).toBe(true);
    await sleep(300);
    expect(isProcessAlive(pid)).toBe(false);
    expect(killDetachedTree(pid, 'SIGTERM')).toBe(false);
  });
});

describe('detached delegation — log tail', () => {
  it('reads only appended lines and tracks the offset', () => {
    const file = join(tmp(), 'l.jsonl');
    writeFileSync(file, '{"type":"trace.step","title":"a"}\n');
    const first = readNewLogLines(file, 0);
    expect(first.lines).toHaveLength(1);
    appendFileSync(file, '{"type":"trace.step","title":"b"}\n');
    const second = readNewLogLines(file, first.offset);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toContain('"b"');
    expect(readNewLogLines(file, second.offset).lines).toEqual([]);
    // A truncated file restarts from zero instead of reading garbage.
    writeFileSync(file, 'x\n');
    expect(readNewLogLines(file, second.offset).lines).toEqual(['x']);
  });

  it('maps useful events to progress text and ignores the rest', () => {
    expect(
      describeDetachedEvent('{"type":"trace.step","title":"Read file","toolName":"read"}')
    ).toBe('Tool: Read file (read)');
    expect(describeDetachedEvent('{"type":"session.ended","sessionId":"s"}')).toContain('finished');
    expect(describeDetachedEvent('{"type":"error","message":"boom"}')).toBe('Error: boom');
    expect(describeDetachedEvent('{"type":"stream.partial","text":"x"}')).toBeNull();
    expect(describeDetachedEvent('not json')).toBeNull();
  });
});

describe('detached delegation — spawn', () => {
  it('creates the log directory, unrefs the child and closes its own descriptor', () => {
    const dir = tmp();
    const plan: DetachedLaunchPlan = {
      command: '/bin/echo',
      args: ['hello'],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      resultFile: join(dir, 'r.json'),
      logFile: join(dir, 'sub', 'l.jsonl'),
    };
    const unref = vi.fn();
    let captured: { command: string; argv: string[]; detached: boolean } | undefined;
    const fake: DetachedSpawnFn = (command, argv, options) => {
      captured = { command, argv, detached: options.detached };
      return { pid: 4321, unref };
    };

    const { pid } = spawnDetachedDelegation(plan, fake);

    expect(pid).toBe(4321);
    expect(captured?.command).toBe('/bin/echo');
    expect(captured?.argv).toEqual(['hello']);
    expect(captured?.detached).toBe(true);
    expect(unref).toHaveBeenCalled();
    // Reading the log after the spawn proves the parent's descriptor is closed.
    expect(readNewLogLines(plan.logFile, 0)).toEqual({ lines: [], offset: 0 });
  });
});
