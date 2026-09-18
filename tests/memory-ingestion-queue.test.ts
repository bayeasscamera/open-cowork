import { describe, expect, it } from 'vitest';
import { MemoryIngestionQueue } from '../src/main/memory/memory-ingestion-queue';

describe('MemoryIngestionQueue', () => {
  it('serializes tasks enqueued under the same key', async () => {
    const queue = new MemoryIngestionQueue();
    const order: string[] = [];

    const first = queue.enqueue('session-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('first');
    });
    const second = queue.enqueue('session-a', async () => {
      order.push('second');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('runs tasks under different keys concurrently', async () => {
    const queue = new MemoryIngestionQueue();
    let running = 0;
    let peak = 0;

    const makeTask = (key: string) =>
      queue.enqueue(key, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
      });

    await Promise.all([makeTask('session-x'), makeTask('session-y')]);
    expect(peak).toBe(2);
  });

  it('continues the chain after a failed task', async () => {
    const queue = new MemoryIngestionQueue();
    const order: string[] = [];

    const failing = queue.enqueue('session-b', async () => {
      throw new Error('extraction failed');
    });
    const next = queue.enqueue('session-b', async () => {
      order.push('after-failure');
    });

    await expect(failing).rejects.toThrow('extraction failed');
    await next;
    expect(order).toEqual(['after-failure']);
  });

  it('clears finished keys from the internal map', async () => {
    const queue = new MemoryIngestionQueue();
    await queue.enqueue('session-c', async () => undefined);
    await queue.enqueue('session-c', async () => undefined);
    await queue.enqueue('session-c', async () => undefined);
    const chains = (queue as unknown as { chains: Map<string, Promise<void>> }).chains;
    expect(chains.size).toBe(0);
  });
});