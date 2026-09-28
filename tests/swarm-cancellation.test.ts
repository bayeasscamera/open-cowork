import { describe, it, expect } from 'vitest';
import { MultiAgentCoordinator } from '../src/main/agent/multi-agent-coordinator';
import type { AgentTask } from '../src/main/agent/multi-agent-coordinator';
import { SubAgentGate } from '../src/main/agent/sub-agent-gate';
import { TaskSlotLimiter } from '../src/main/agent/swarm-runner';
import {
  getRunSignal,
  registerRunSignal,
  resetRunSignals,
  unregisterRunSignal,
} from '../src/main/agent/run-abort-registry';

/**
 * Cancellation reached the swarm only for the async-delegation path, which
 * supplied a signal through `taskExtras`. The coordinator had none: pressing
 * Stop left every sub-agent running to completion, and slots queued behind a
 * full budget were never released, so the plan never settled.
 */
describe('MultiAgentCoordinator — cancellation', () => {
  it('forwards the plan signal to the runner as a third argument', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];

    const coordinator = new MultiAgentCoordinator(async (task, context, signal) => {
      seen.push(signal);
      return { output: 'ok' };
    });
    const plan = coordinator.createCollaborativePlan('goal');
    await coordinator.executePlan(plan.id, { signal: controller.signal });

    expect(seen.length).toBe(4);
    expect(seen.every((s) => s === controller.signal)).toBe(true);
  });

  it('stops scheduling new waves once aborted and marks the rest skipped', async () => {
    const controller = new AbortController();
    const started: string[] = [];

    const coordinator = new MultiAgentCoordinator(async (task) => {
      started.push(task.role);
      // Cancel while the first (architect) task is running: its dependents
      // must never be launched.
      controller.abort();
      return { output: 'ok' };
    });
    const plan = coordinator.createCollaborativePlan('goal');
    const done = await coordinator.executePlan(plan.id, { signal: controller.signal });

    expect(started).toEqual(['architect']);
    const skipped = done.tasks.filter((t) => t.status === 'skipped');
    expect(skipped.length).toBe(3);
    expect(skipped.every((t) => t.error === 'Cancelled by user')).toBe(true);
    // Nothing may be left dangling as pending/in_progress.
    expect(done.tasks.every((t) => t.status !== 'pending')).toBe(true);
    expect(done.tasks.every((t) => t.status !== 'in_progress')).toBe(true);
  });

  it('reports an aborted task as skipped, never as a sub-agent failure', async () => {
    const controller = new AbortController();
    const coordinator = new MultiAgentCoordinator(async () => {
      controller.abort();
      throw new Error('Sub-agent aborted');
    });
    const plan = coordinator.createCollaborativePlan('goal');
    const done = await coordinator.executePlan(plan.id, { signal: controller.signal });

    expect(done.tasks.every((t) => t.status === 'skipped')).toBe(true);
    expect(done.tasks.some((t) => t.status === 'failed')).toBe(false);
  });

  it('resolves even when every runner hangs — the signal must unblock the plan', async () => {
    const controller = new AbortController();
    const coordinator = new MultiAgentCoordinator(async (_task, _context, signal) => {
      // A runner that only settles on cancellation, like the real one racing
      // piSession.prompt() against the abort promise.
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Sub-agent aborted')));
      });
      return { output: 'unreachable' };
    });
    const plan = coordinator.createCollaborativePlan('goal');
    setTimeout(() => controller.abort(), 20);

    const done = await coordinator.executePlan(plan.id, { signal: controller.signal });
    expect(done.tasks.every((t) => t.status !== 'in_progress')).toBe(true);
    expect(done.tasks.every((t) => t.status !== 'pending')).toBe(true);
  });

  it('does not retry failed tasks when the plan was cancelled', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const coordinator = new MultiAgentCoordinator(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      controller.abort();
      return { output: 'ok' };
    });
    const plan = coordinator.createCollaborativePlan('goal', {
      aggregationPolicy: 'retry-failed-only',
    });
    await coordinator.executePlan(plan.id, { signal: controller.signal });

    // The cancellation landed during the recovery round: it must stop there
    // rather than burning the remaining retries on an abandoned plan.
    expect(attempts).toBeLessThanOrEqual(2);
  });

  it('keeps the historical behaviour when no signal is supplied', async () => {
    const executed: string[] = [];
    const coordinator = new MultiAgentCoordinator(async (task) => {
      executed.push(task.role);
      return { output: 'ok' };
    });
    const plan = coordinator.createCollaborativePlan('goal');
    const done = await coordinator.executePlan(plan.id);

    expect(done.status).toBe('done');
    expect(done.tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(executed.length).toBe(4);
  });
});

describe('slot acquire — cancellation does not leak capacity', () => {
  it('SubAgentGate drops a cancelled waiter instead of reserving a slot', async () => {
    const gate = new SubAgentGate(1);
    await gate.acquire();

    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toThrow('Sub-agent aborted');

    // The queued holder is gone: the next one must take the freed slot
    // instead of waiting behind a ghost.
    gate.release();
    let nextEntered = false;
    const next = gate.acquire().then(() => {
      nextEntered = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(nextEntered).toBe(true);
    expect(gate.activeCount).toBe(1);
  });

  it('SubAgentGate rejects immediately when the signal is already aborted', async () => {
    const gate = new SubAgentGate(2);
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire(controller.signal)).rejects.toThrow('Sub-agent aborted');
    expect(gate.activeCount).toBe(0);
  });

  it('TaskSlotLimiter drops a cancelled waiter and keeps the budget intact', async () => {
    const limiter = new TaskSlotLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow('Sub-agent aborted');

    // The transfer in release() must have gone to nobody.
    limiter.release();
    expect(limiter.activeCount).toBe(0);

    let nextEntered = false;
    const next = limiter.acquire().then(() => {
      nextEntered = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(nextEntered).toBe(true);
    expect(limiter.activeCount).toBe(1);
  });

  it('a waiter that wins the slot is unaffected by a later abort', async () => {
    const limiter = new TaskSlotLimiter(1);
    await limiter.acquire();
    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    // Slot handed over before the cancel arrives: the holder keeps it.
    limiter.release();
    controller.abort();
    await expect(queued).resolves.toBeUndefined();
    expect(limiter.activeCount).toBe(1);
  });
});

describe('run-abort-registry', () => {
  it('resolves the signal of the turn currently running', () => {
    resetRunSignals();
    const controller = new AbortController();
    registerRunSignal('s1', controller.signal);
    expect(getRunSignal('s1')).toBe(controller.signal);
    resetRunSignals();
  });

  it('refuses a dead signal and a missing session', () => {
    resetRunSignals();
    const controller = new AbortController();
    controller.abort();
    registerRunSignal('s1', controller.signal);
    // An already-aborted handle is useless: the tool must run uncancellable
    // rather than abort instantly on a stale registration.
    expect(getRunSignal('s1')).toBeUndefined();
    expect(getRunSignal(undefined)).toBeUndefined();
    expect(getRunSignal('nope')).toBeUndefined();
    resetRunSignals();
  });

  it('a late cleanup cannot delete the signal of the turn that replaced it', () => {
    resetRunSignals();
    const first = new AbortController();
    const second = new AbortController();
    registerRunSignal('s1', first.signal);
    registerRunSignal('s1', second.signal);

    // Turn 1's finally block lands after turn 2 started.
    unregisterRunSignal('s1', first.signal);
    expect(getRunSignal('s1')).toBe(second.signal);

    unregisterRunSignal('s1', second.signal);
    expect(getRunSignal('s1')).toBeUndefined();
    resetRunSignals();
  });
});
