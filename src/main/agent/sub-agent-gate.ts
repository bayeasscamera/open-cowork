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

  /**
   * Take a slot, waiting for one when the budget is exhausted.
   *
   * With a `signal`, a queued holder that gets cancelled while waiting is
   * REMOVED from the queue instead of being woken by the next release: without
   * it a cancelled sub-agent would sit in the FIFO forever, keep the next
   * release reserved, and the parent's `Promise.all` would never settle.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Sub-agent aborted');
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: () => void = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        cleanup();
        reject(new Error('Sub-agent aborted'));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
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
