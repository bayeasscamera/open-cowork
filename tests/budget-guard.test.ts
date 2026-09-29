import { describe, it, expect } from 'vitest';
import { BudgetGuard, budgetIsSatisfiable } from '../src/main/agent/budget-guard';

describe('BudgetGuard', () => {
  it('tracks tool calls against the declared ceiling', () => {
    let now = 1000;
    const guard = new BudgetGuard({ maxToolCalls: 3 }, { now: () => now });
    expect(guard.exceeded).toBe(false);

    guard.recordToolCall();
    guard.recordToolCall(2);
    expect(guard.toolCalls).toBe(3);
    // The ceiling is inclusive: 3 of 3 is still inside the budget.
    expect(guard.exceeded).toBe(false);

    guard.recordToolCall();
    expect(guard.exceeded).toBe(true);
    expect(guard.reason()).toContain('Tool-call budget exceeded');
  });

  it('ignores nonsensical tool-call counts', () => {
    const guard = new BudgetGuard({ maxToolCalls: 3 });
    guard.recordToolCall(0);
    guard.recordToolCall(-5);
    expect(guard.toolCalls).toBe(0);
    expect(guard.exceeded).toBe(false);
  });

  it('stops when the elapsed time exceeds the budget', () => {
    let now = 0;
    const guard = new BudgetGuard({ maxDurationMs: 100 }, { now: () => now });
    now = 150;
    expect(guard.elapsedMs).toBe(150);
    expect(guard.exceeded).toBe(true);
    expect(guard.reason()).toContain('Time budget');
  });

  it('stops when the token budget is spent', () => {
    const tokens = new BudgetGuard({ maxTokens: 100 });
    tokens.recordTokens(101);
    expect(tokens.exceeded).toBe(true);
    expect(tokens.reason()).toContain('Token budget exceeded');
  });

  it('stops when the cost budget is spent', () => {
    // The ceiling lives on TaskBudget as `estimatedCostUsd`. It is what the
    // plan approval page displays and what task-planner sums into the plan
    // total, so spending past it has to be a budget failure like any other.
    // The previous version of this test passed `maxCostUsd`, a key that does
    // not exist on TaskBudget, so it asserted on a budget that could never
    // have been exceeded.
    const cost = new BudgetGuard({ estimatedCostUsd: 0.5 });
    cost.recordCost(0.4);
    // The ceiling is inclusive, like every other one: 0.40 of 0.50 still fits.
    expect(cost.exceeded).toBe(false);
    expect(cost.usage().costUsd).toBeCloseTo(0.4);

    cost.recordCost(0.2);
    expect(cost.usage().costUsd).toBeCloseTo(0.6);
    expect(cost.exceeded).toBe(true);
    expect(cost.reason()).toContain('Cost budget exceeded');
    expect(cost.reason()).toContain('0.6000');
    expect(cost.reason()).toContain('0.5000');
  });

  it('reports the first exceeded ceiling, not the cost one, when several apply', () => {
    // A caller acting on the first reason should get the cheapest, most
    // deterministic ceiling — not the cost one, which is the least exact.
    const guard = new BudgetGuard({ maxToolCalls: 1, estimatedCostUsd: 0.01 });
    guard.recordToolCall(5);
    guard.recordCost(5);
    expect(guard.reason()).toContain('Tool-call budget exceeded');
  });

  it('tracks cost without a ceiling when none is declared', () => {
    // Most plans declare no cost ceiling, and spending must then be reported
    // rather than rejected.
    const cost = new BudgetGuard({ maxTokens: 1000 });
    cost.recordCost(999);
    expect(cost.usage().costUsd).toBeCloseTo(999);
    expect(cost.exceeded).toBe(false);
  });

  it('reports usage and status with a single reason', () => {
    const guard = new BudgetGuard({ maxToolCalls: 1, maxTokens: 10 });
    guard.recordToolCall(2);
    guard.recordTokens(20);

    const usage = guard.usage();
    expect(usage.toolCalls).toBe(2);
    expect(usage.tokens).toBe(20);
    expect(usage.costUsd).toBe(0);
    expect(guard.status().exceeded).toBe(true);
    expect(guard.status().reason).toBe(guard.reason());
    expect(guard.status().toolCalls).toBe(2);
  });

  it('never exceeds a budget with no ceilings at all', () => {
    const guard = new BudgetGuard({});
    guard.recordToolCall(1000);
    guard.recordTokens(1_000_000);
    guard.recordCost(999);
    expect(guard.exceeded).toBe(false);
    expect(guard.reason()).toBeNull();
  });
});

describe('budgetIsSatisfiable', () => {
  it('rejects budgets that are already impossible', () => {
    expect(budgetIsSatisfiable({ maxTokens: 0 })).toBe(false);
    expect(budgetIsSatisfiable({ maxDurationMs: 0 })).toBe(false);
    expect(budgetIsSatisfiable({ maxToolCalls: -1 })).toBe(false);
    // A zero cost ceiling is the same mistake: the very first cent trips it.
    expect(budgetIsSatisfiable({ estimatedCostUsd: 0 })).toBe(false);
    expect(budgetIsSatisfiable({ estimatedCostUsd: -0.01 })).toBe(false);
  });

  it('accepts a budget with usable headroom', () => {
    expect(budgetIsSatisfiable({ maxTokens: 1 })).toBe(true);
    expect(budgetIsSatisfiable({ estimatedCostUsd: 0.01 })).toBe(true);
    expect(budgetIsSatisfiable({})).toBe(true);
  });
});
