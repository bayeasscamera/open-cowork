/**
 * Chantier 4 — faster boot.
 *
 * Proofs:
 *  1. BootProfiler records honest per-stage timings (unit math, no clock mocks
 *     needed — deltas are relative, so any monotonic clock works).
 *  2. withBudget stops waiting at the budget without cancelling the work, and
 *     passes fast results straight through.
 *  3. CapabilityDiskCache serves fresh entries, expires after TTL, survives a
 *     corrupt file as a miss, and never throws on an unwritable dir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { BootProfiler } from '../src/main/startup/boot-perf';
import { withBudget } from '../src/main/config/secret-resolver';
import {
  CapabilityDiskCache,
  CAPABILITY_CACHE_TTL_MS,
} from '../src/main/config/capability-cache';

describe('BootProfiler', () => {
  it('records per-stage deltas that sum to the total', () => {
    const profiler = new BootProfiler();
    profiler.mark('config-applied');
    profiler.mark('database-ready');
    profiler.mark('window-shown');
    const summary = profiler.summary();
    expect(summary).toHaveLength(3);
    expect(summary[0]?.stage).toBe('config-applied');
    const deltas = summary.reduce((acc, sample) => acc + sample.deltaMs, 0);
    // Sum of deltas ~= total (both derive from the same clock; allow 1ms rounding).
    expect(Math.abs(deltas - profiler.totalMs())).toBeLessThanOrEqual(1);
    expect(profiler.totalMs()).toBeGreaterThanOrEqual(0);
  });

  it('formats a paste-friendly report', () => {
    const profiler = new BootProfiler();
    profiler.mark('a');
    const text = profiler.format();
    expect(text).toContain('a: +');
    expect(text).toContain('total:');
  });

  it('is empty before the first mark and resettable', () => {
    const profiler = new BootProfiler();
    expect(profiler.summary()).toHaveLength(0);
    expect(profiler.totalMs()).toBe(0);
    profiler.mark('x');
    profiler.reset();
    expect(profiler.summary()).toHaveLength(0);
  });
});

describe('withBudget', () => {
  it('passes a fast result straight through', async () => {
    await expect(withBudget(Promise.resolve('key'), 1000)).resolves.toBe('key');
  });

  it('stops waiting at the budget and yields null', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    const started = Date.now();
    await expect(withBudget(slow, 50)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('treats a rejection as a miss, never throws', async () => {
    await expect(withBudget(Promise.reject(new Error('vault locked')), 1000)).resolves.toBeNull();
  });
});

describe('CapabilityDiskCache', () => {
  let dir: string;
  let cache: CapabilityDiskCache;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-capcache-'));
    cache = new CapabilityDiskCache(dir);
  });

  it('misses before anything is stored', () => {
    expect(cache.get('cli-presence:op')).toBeNull();
  });

  it('serves a fresh entry and expires it after the TTL', () => {
    cache.set('k', { installed: true });
    expect(cache.get('k')).toEqual({ installed: true });
    expect(cache.get('k', -1)).toBeNull();
    expect(cache.getStale('k')).toEqual({ installed: true });
  });

  it('exposes the 24h default TTL', () => {
    expect(CAPABILITY_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('treats a corrupt file as a miss, never throws', () => {
    fs.writeFileSync(path.join(dir, 'capability-cache.json'), '{not json', 'utf8');
    expect(cache.get('k')).toBeNull();
    // And the cache self-heals on the next write.
    cache.set('k', 1);
    expect(cache.get('k')).toBe(1);
  });

  it('never throws on an unwritable location', () => {
    const readOnly = new CapabilityDiskCache(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x'), 'blocker', 'utf8');
    expect(() => readOnly.set('k', 1)).not.toThrow();
    expect(readOnly.get('k')).toBeNull();
  });

  it('persists across instances rooted at the same dir', () => {
    cache.set('ollama-discovery', { available: true });
    const reopened = new CapabilityDiskCache(dir);
    expect(reopened.get('ollama-discovery')).toEqual({ available: true });
  });

  it('clear removes every entry', () => {
    cache.set('k', 1);
    cache.clear();
    expect(cache.get('k')).toBeNull();
    expect(cache.getStale('k')).toBeNull();
  });
});
