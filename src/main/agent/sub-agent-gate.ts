/**
 * GLOBAL semaphore across the whole sub-agent hierarchy (swarm level 1,
 * async delegations, and recursive children): no more than `max` sub-agents
 * COMPUTE at the same time, all levels combined. The max is adjustable at
 * runtime (delegation settings). A parked parent (blocked on its child)
 * temporarily transfers its slot to the child, so a waiting parent never
 * deadlocks against its own subordinate.
 */
export class SubAgentGate {
  private active = 0;
  private max: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  setMax(max: number): void {
    this.max = Math.max(1, max);
    this.pump();
  }

  get activeCount(): number {
    return this.active;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  /** Test hook: release everything (never used in production paths). */
  reset(): void {
    this.active = 0;
    this.pump();
  }

  private pump(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      this.active += 1;
      this.waiters.shift()?.();
    }
  }
}
