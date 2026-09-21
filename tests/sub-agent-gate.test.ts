import { describe, it, expect } from 'vitest';
import { SubAgentGate } from '../src/main/agent/sub-agent-gate';

describe('SubAgentGate — GLOBAL hierarchy semaphore', () => {
  it('bounds concurrency across ALL holders combined (not per level)', async () => {
    const gate = new SubAgentGate(2);
    await gate.acquire(); // e.g. a depth-1 swarm task
    await gate.acquire(); // e.g. a recursive depth-2 child
    expect(gate.activeCount).toBe(2);

    // A third holder — any level — must WAIT for a global slot.
    let thirdEntered = false;
    const third = gate.acquire().then(() => {
      thirdEntered = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(thirdEntered).toBe(false);

    gate.release();
    await third;
    expect(thirdEntered).toBe(true);
    expect(gate.activeCount).toBe(2);
  });

  it('setMax raises the shared budget at runtime (delegation settings)', async () => {
    const gate = new SubAgentGate(1);
    await gate.acquire();
    let secondEntered = false;
    const second = gate.acquire().then(() => {
      secondEntered = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondEntered).toBe(false);

    gate.setMax(2);
    await second;
    expect(secondEntered).toBe(true);
  });

  it('release without holders never goes negative', () => {
    const gate = new SubAgentGate(2);
    gate.release();
    gate.release();
    expect(gate.activeCount).toBe(0);
  });

  it('wiring — the swarm runner uses the SAME global gate instance as delegations', async () => {
    const { readFileSync } = await import('node:fs');
    const creator = readFileSync('src/main/tools/dynamic-tool-creator.ts', 'utf8');
    expect(creator).toContain('createSwarmRunner({ cwd: swarmCwd, gate: subAgentGate })');
    const delegations = readFileSync('src/main/agent/background-delegations.ts', 'utf8');
    expect(delegations).toContain('gate: subAgentGate');
    // One shared singleton — not a per-level construction.
    expect(delegations).toMatch(/export const subAgentGate = new SubAgentGate/);
    const runner = readFileSync('src/main/agent/swarm-runner.ts', 'utf8');
    expect(runner).toContain('options.gate');
    // Child inherits the SAME workspace as the parent (identical confinement).
    expect(runner).toContain('cwd: args.cwd');
  });
});
