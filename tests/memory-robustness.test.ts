/**
 * Robustness follow-ups: no unbounded waits, no duplicate unhandled
 * rejections, no wedged scan flag.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  MemoryLlmLimiter,
  MemoryLlmTimeoutError,
} from '../src/main/memory/memory-llm-limiter';
import { MemoryIngestionQueue } from '../src/main/memory/memory-ingestion-queue';
import { CodeGraphIndexer } from '../src/main/memory/codegraph-indexer';

describe('MemoryLlmLimiter acquire budget', () => {
  it('rejects instead of parking forever when no slot frees up', async () => {
    const limiter = new MemoryLlmLimiter();
    await limiter.acquire();
    await expect(limiter.acquire('background', { timeoutMs: 30 })).rejects.toBeInstanceOf(
      MemoryLlmTimeoutError
    );
    expect(limiter.pendingCount).toBe(0);
    limiter.release();
    // The limiter still works after a timeout.
    await limiter.acquire('background', { timeoutMs: 100 });
    limiter.release();
  });

  it('has a finite default budget', () => {
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });
});

describe('MemoryIngestionQueue rejection hygiene', () => {
  it('a failed task rejects to its caller without an unhandled rejection', async () => {
    const queue = new MemoryIngestionQueue();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      await expect(
        queue.enqueue('k', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      // A later task on the same key still runs: the chain survived.
      await queue.enqueue('k', async () => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', listener);
    }
  });
});

describe('CodeGraphIndexer scan serialization', () => {
  it('resets the scanning flag even when a scan throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegraph-robust-'));
    try {
      writeFileSync(join(dir, 'notes.md'), '# hi\n', 'utf8');
      const indexer = new CodeGraphIndexer(join(dir, 'cache'));
      // Force the guarded traversal to reject: the production code guards
      // every I/O site internally, so the only throwing path left is a
      // defect inside the scan itself — exactly what the finally covers.
      const broken = indexer as unknown as {
        scanDirectoryUncached: () => Promise<never>;
      };
      const original = broken.scanDirectoryUncached.bind(indexer);
      broken.scanDirectoryUncached = async () => {
        throw new Error('simulated scan defect');
      };
      await expect(indexer.scanDirectory(dir, ['.md'], true)).rejects.toThrow(
        'simulated scan defect'
      );
      expect(indexer.isCurrentlyScanning()).toBe(false);
      // And the indexer still works afterwards.
      broken.scanDirectoryUncached = original;
      const ok = await indexer.scanDirectory(dir, ['.md'], true);
      expect(ok.filesCount).toBeGreaterThanOrEqual(1);
      expect(indexer.isCurrentlyScanning()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes two concurrent scans instead of racing on the shared index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegraph-serial-'));
    try {
      const dirA = join(dir, 'a');
      const dirB = join(dir, 'b');
      const { mkdirSync } = await import('fs');
      mkdirSync(dirA);
      mkdirSync(dirB);
      writeFileSync(join(dirA, 'one.md'), '# a\n', 'utf8');
      writeFileSync(join(dirB, 'two.md'), '# b\n', 'utf8');
      const indexer = new CodeGraphIndexer(join(dir, 'cache'));
      const [ra, rb] = await Promise.all([
        indexer.scanDirectory(dirA, ['.md'], true),
        indexer.scanDirectory(dirB, ['.md'], true),
      ]);
      // Each result carries its own directory's symbols; neither scan
      // corrupted the other through the shared index.
      expect(ra.filesCount).toBe(1);
      expect(rb.filesCount).toBe(1);
      expect(indexer.isCurrentlyScanning()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
