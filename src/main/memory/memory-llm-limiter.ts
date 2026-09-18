/**
 * Priority-aware concurrency gate for auxiliary memory LLM calls.
 *
 * Memory summarization and extraction share the provider rate limit with
 * live conversations, so auxiliary calls are serialized by default.
 * Foreground calls (user-visible navigation) jump ahead of queued background
 * work, and a provider 429 pauses every queued call instead of letting each
 * caller retry independently against the same quota.
 */

export type MemoryLlmPriority = 'foreground' | 'background';

export interface MemoryLlmLimiterOptions {
  /** Maximum number of completions in flight; defaults to 1. */
  maxConcurrent?: number;
}

interface Waiter {
  priority: MemoryLlmPriority;
  resolve: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class MemoryLlmLimiter {
  private running = 0;
  private readonly waiters: Waiter[] = [];
  private cooldownUntil = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxConcurrent: number;

  constructor(options?: MemoryLlmLimiterOptions) {
    this.maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrent ?? 1));
  }

  get runningCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  async acquire(priority: MemoryLlmPriority = 'background'): Promise<void> {
    for (;;) {
      const cooldownMs = this.cooldownUntil - Date.now();
      if (cooldownMs > 0) {
        await sleep(cooldownMs);
        continue;
      }
      if (this.running < this.maxConcurrent) {
        this.running += 1;
        return;
      }
      await new Promise<void>((resolve) => this.enqueue({ priority, resolve }));
    }
  }

  release(): void {
    this.running = Math.max(0, this.running - 1);
    this.pump();
  }

  /** Hold every queued call until the cooldown elapses (provider 429). */
  notifyRateLimited(cooldownMs: number): void {
    if (cooldownMs <= 0) return;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
    this.scheduleCooldownPump();
  }

  private enqueue(waiter: Waiter): void {
    if (waiter.priority === 'foreground') {
      const firstBackground = this.waiters.findIndex((item) => item.priority === 'background');
      if (firstBackground === -1) {
        this.waiters.push(waiter);
      } else {
        this.waiters.splice(firstBackground, 0, waiter);
      }
      return;
    }
    this.waiters.push(waiter);
  }

  private pump(): void {
    if (Date.now() < this.cooldownUntil) return;
    if (this.running >= this.maxConcurrent) return;
    const next = this.waiters.shift();
    if (!next) return;
    next.resolve();
  }

  private scheduleCooldownPump(): void {
    if (this.cooldownTimer) return;
    const delay = Math.max(0, this.cooldownUntil - Date.now());
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      if (Date.now() < this.cooldownUntil) {
        this.scheduleCooldownPump();
        return;
      }
      this.pump();
    }, delay);
    this.cooldownTimer.unref?.();
  }
}