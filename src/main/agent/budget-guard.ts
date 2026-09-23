/**
 * @module main/agent/budget-guard
 *
 * Cowork 4.0 — Phase 3.2: every task and sub-agent runs under an explicit
 * budget. The guard is the single place that decides when that budget is spent,
 * so the same rule applies to the workflow executor, the sub-agent tool and the
 * reference-scenario harness.
 */

import type { TaskBudget } from '../../shared/task-contract';
import type { TaskBudgetStatus } from '../../shared/workflow-types';

export interface BudgetUsage {
  toolCalls: number;
  elapsedMs: number;
  tokens: number;
  costUsd: number;
}

export interface BudgetGuardOptions {
  now?: () => number;
  startedAt?: number;
}

export class BudgetGuard {
  private readonly budget: TaskBudget;
  private readonly now: () => number;
  private readonly startedAt: number;
  private toolCallCount = 0;
  private tokenCount = 0;
  private costUsd = 0;

  constructor(budget: TaskBudget = {}, options: BudgetGuardOptions = {}) {
    this.budget = budget;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = options.startedAt ?? this.now();
  }

  public recordToolCall(count = 1): void {
    this.toolCallCount += Math.max(0, count);
  }

  public recordTokens(count: number): void {
    this.tokenCount += Math.max(0, count);
  }

  public recordCost(costUsd: number): void {
    this.costUsd += Math.max(0, costUsd);
  }

  public get toolCalls(): number {
    return this.toolCallCount;
  }

  public get elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  public usage(): BudgetUsage {
    return {
      toolCalls: this.toolCallCount,
      elapsedMs: this.elapsedMs,
      tokens: this.tokenCount,
      costUsd: this.costUsd,
    };
  }

  /** First exceeded ceiling, or null when the budget still holds. */
  public reason(): string | null {
    const maxToolCalls = this.budget.maxToolCalls;
    if (typeof maxToolCalls === 'number' && this.toolCallCount > maxToolCalls) {
      return 'Tool-call budget exceeded (' + this.toolCallCount + '/' + maxToolCalls + ').';
    }
    const maxTokens = this.budget.maxTokens;
    if (typeof maxTokens === 'number' && this.tokenCount > maxTokens) {
      return 'Token budget exceeded (' + this.tokenCount + '/' + maxTokens + ').';
    }
    const maxDurationMs = this.budget.maxDurationMs;
    if (typeof maxDurationMs === 'number' && this.elapsedMs > maxDurationMs) {
      return 'Time budget exceeded (' + this.elapsedMs + 'ms/' + maxDurationMs + 'ms).';
    }
    return null;
  }

  public get exceeded(): boolean {
    return this.reason() !== null;
  }

  public status(): TaskBudgetStatus {
    const reason = this.reason();
    return {
      exceeded: reason !== null,
      reason,
      toolCalls: this.toolCallCount,
      elapsedMs: this.elapsedMs,
    };
  }
}

/** Convenience: is a budget already unusable before the run even starts? */
export function budgetIsSatisfiable(budget: TaskBudget): boolean {
  if (typeof budget.maxToolCalls === 'number' && budget.maxToolCalls <= 0) {
    return false;
  }
  if (typeof budget.maxTokens === 'number' && budget.maxTokens <= 0) {
    return false;
  }
  if (typeof budget.maxDurationMs === 'number' && budget.maxDurationMs <= 0) {
    return false;
  }
  return true;
}
