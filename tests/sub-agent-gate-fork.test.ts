import { describe, expect, it } from 'vitest';

import { SubAgentGate } from '../src/main/agent/sub-agent-gate';

/**
 * A fork is just another sub-agent as far as the global semaphore is concerned,
 * so it must not be able to deadlock. The specific hazard the gate exists to
 * prevent: a parent that is BLOCKED waiting on its child while still holding a
 * slot. With one slot and max=1, a naive implementation waits forever.
 *
 * The documented mitigation is slot transfer: the parked parent releases its
 * slot before waiting and re-acquires it when the child is done. These tests
 * exercise that contract on the real gate.
 */
describe('SubAgentGate slot transfer (fork does not deadlock)', () => {
  it('transfers the slot so a blocked parent and its child both make progress', async () => {
    const gate = new SubAgentGate(1);

    // Parent takes the only slot.
    await gate.acquire();
    expect(gate.activeCount).toBe(1);

    // The parent is about to block on its child, so it transfers its slot.
    // This is what the swarm does via gateSlot.release()/reacquire().
    gate.release();
    expect(gate.activeCount).toBe(0);

    // The child can now take the slot and run.
    const childRan = await (async () => {
      await gate.acquire();
      expect(gate.activeCount).toBe(1);
      return true;
    })();

    // The child finishes and releases.
    gate.release();
    expect(gate.activeCount).toBe(0);

    // The parent resumes and re-acquires — without hanging.
    const parentResumed = await Promise.race([
      gate.acquire().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);

    expect(childRan).toBe(true);
    expect(parentResumed).toBe(true);
    gate.release();
  });

  it('never exceeds the cap even when a parent transfers to several children', async () => {
    const gate = new SubAgentGate(2);
    const observed: number[] = [];

    await gate.acquire();
    await gate.acquire();
    observed.push(gate.activeCount);

    // Parent releases both slots to its two children.
    gate.release();
    gate.release();
    expect(gate.activeCount).toBe(0);

    const child1 = gate.acquire().then(() => gate.activeCount);
    const child2 = gate.acquire().then(() => gate.activeCount);
    await Promise.all([child1, child2]);

    // Never more than the cap, even with both children racing.
    expect(gate.activeCount).toBeLessThanOrEqual(2);
    expect(observed[0]).toBe(2);
    gate.release();
    gate.release();
  });

  it('a cancelled waiter is removed from the queue instead of blocking the next release', async () => {
    const gate = new SubAgentGate(1);
    await gate.acquire();

    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    controller.abort();

    // The queued holder is dropped, not woken by the next release.
    await expect(queued).rejects.toThrow('Sub-agent aborted');

    gate.release();
    // A fresh acquirer still gets the slot: the cancelled one did not reserve it.
    const acquired = await Promise.race([
      gate.acquire().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(acquired).toBe(true);
    gate.release();
  });

  it('raising the cap releases the waiters that were queued under the old one', async () => {
    const gate = new SubAgentGate(1);
    await gate.acquire();

    const waiter = gate.acquire();
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });

    // Still blocked under the old cap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    gate.setMax(2);
    await waiter;
    expect(settled).toBe(true);
  });
});
