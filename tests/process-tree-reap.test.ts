import { spawn } from 'child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectDescendantPids,
  isPidAlive,
  parseProcessTable,
  reapPids,
} from '../src/main/utils/process-tree';

describe('parseProcessTable', () => {
  it('parses pid/ppid pairs and ignores noise lines', () => {
    const edges = parseProcessTable('  100     1\n200  100\nPID PPID\njunk\n300 100\n');
    expect(edges).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 100 },
    ]);
  });
});

describe('collectDescendantPids', () => {
  const edges = [
    { pid: 1, ppid: 0 },
    { pid: 10, ppid: 1 },
    { pid: 20, ppid: 10 },
    { pid: 30, ppid: 20 },
    { pid: 40, ppid: 10 },
    { pid: 55, ppid: 55 },
  ];

  it('walks transitive descendants and excludes the root', () => {
    expect(collectDescendantPids(edges, 10).slice().sort()).toEqual([20, 30, 40]);
  });

  it('returns deepest first so children die before parents', () => {
    const order = collectDescendantPids(edges, 10);
    expect(order.indexOf(30)).toBeLessThan(order.indexOf(20));
    expect(order).not.toContain(55);
  });

  it('handles leaf nodes and unknown roots', () => {
    expect(collectDescendantPids(edges, 30)).toEqual([]);
    expect(collectDescendantPids(edges, 99999)).toEqual([]);
  });
});

describe('reapPids', () => {
  it('reports zero for pids that are already dead', async () => {
    expect(await reapPids([99999], 50)).toBe(0);
  });
});

const posix = process.platform !== 'win32';
describe.skipIf(posix === false)('reapPids integration (POSIX)', () => {
  it('SIGTERMs a live process and guarantees it is dead afterwards', async () => {
    const sleeper = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    const exited = new Promise<void>((r) => sleeper.once('exit', () => r()));
    try {
      expect(isPidAlive(sleeper.pid)).toBe(true);
      const reaped = await reapPids([sleeper.pid], 150);
      expect(reaped).toBe(1);
      // SIGTERM may need a moment to be delivered + collected by Node.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      expect(isPidAlive(sleeper.pid)).toBe(false);
    } finally {
      if (isPidAlive(sleeper.pid)) sleeper.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
  }, 15000);

  it('survives a batch mixing live and dead pids', async () => {
    const sleeper = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    const exited = new Promise<void>((r) => {
      sleeper.once('exit', () => r());
      sleeper.once('error', () => r());
    });
    try {
      const reaped = await reapPids([999999, sleeper.pid], 100);
      expect(reaped).toBe(1);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    } finally {
      if (isPidAlive(sleeper.pid)) sleeper.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
  }, 10000);
});

describe('MCP disconnect reaping integration', () => {
  const src = readFileSync(resolve(__dirname, '../src/main/mcp/mcp-manager.ts'), 'utf8');

  it('records the stdio subtree BEFORE closing the transport', () => {
    const disconnect = src.match(/async disconnectServer[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(disconnect).toContain('getStdioTransportPid(transport)');
    const capture = disconnect.indexOf('listDescendantPids(stdioPid)');
    const close = disconnect.indexOf('transport.close()');
    expect(capture).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(capture);
    expect(disconnect).toContain('reapPids(candidates)');
  });
});
