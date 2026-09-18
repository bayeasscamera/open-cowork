import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLlmLimiter } from '../src/main/memory/memory-llm-limiter';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MemoryLlmLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('serializes acquisitions by default', async () => {
    const limiter = new MemoryLlmLimiter();
    const order: string[] = [];

    const first = (async () => {
      await limiter.acquire();
      order.push('first-start');
      await flush();
      order.push('first-end');
      limiter.release();
    })();

    const second = (async () => {
      await limiter.acquire();
      order.push('second-start');
      limiter.release();
    })();

    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('lets a foreground call jump ahead of queued background calls', async () => {
    const limiter = new MemoryLlmLimiter();
    const order: string[] = [];

    await limiter.acquire();
    const background = limiter.acquire('background').then(() => {
      order.push('background');
      limiter.release();
    });
    const foreground = limiter.acquire('foreground').then(() => {
      order.push('foreground');
      limiter.release();
    });

    limiter.release();
    await Promise.all([background, foreground]);
    expect(order).toEqual(['foreground', 'background']);
  });

  it('holds queued calls during a rate-limit cooldown', async () => {
    vi.useFakeTimers();
    const limiter = new MemoryLlmLimiter();
    const started: number[] = [];

    await limiter.acquire();
    const queued = limiter.acquire().then(() => {
      started.push(Date.now());
    });

    limiter.notifyRateLimited(5000);
    limiter.release();

    await vi.advanceTimersByTimeAsync(4999);
    expect(started).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await queued;
    expect(started.length).toBe(1);
    limiter.release();
  });

  it('never lets more than maxConcurrent calls run at once', async () => {
    const limiter = new MemoryLlmLimiter({ maxConcurrent: 2 });
    let inFlight = 0;
    let peak = 0;

    const tasks = Array.from({ length: 6 }, async () => {
      await limiter.acquire();
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight -= 1;
      limiter.release();
    });

    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(limiter.pendingCount).toBe(0);
  });
});

describe('memory navigation priority wiring', () => {
  it('marks user-visible navigation completions as foreground', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/memory/memory-navigator.ts'),
      'utf8'
    );
    expect(source).toContain("priority: 'foreground'");
  });
});